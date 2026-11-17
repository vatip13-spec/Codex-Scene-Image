import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

export const info = {
    id: 'codex-scene-image',
    name: 'Codex Scene Image',
    description: 'Generate and open scene images through the local Codex CLI.',
};

const runFile = promisify(execFile);
const jobs = new Map();
const modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const maxImageBytes = 64 * 1024 * 1024;
const generationTimeout = 10 * 60 * 1000;
const instruction = [
    'Use the built-in $imagegen tool to generate exactly one PNG image.',
    'Use the visual brief below as the image description.',
    'After the tool runs, briefly report whether it succeeded, or report the exact reason it failed.',
    'Omit drawing, shell commands, and external API fallbacks.',
].join(' ');

async function getCodexCommand(env) {
    if (env.ST_CODEX_EXECUTABLE) {
        if (!path.isAbsolute(env.ST_CODEX_EXECUTABLE)) {
            throw new Error('ST_CODEX_EXECUTABLE에 Codex 실행 파일의 절대 경로를 지정해 주세요.');
        }
        const file = env.ST_CODEX_EXECUTABLE;
        if (/\.[cm]?js$/i.test(file)) return [process.execPath, file];
        if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
            throw new Error('Windows에서는 codex.exe 또는 npm 패키지의 codex.js 경로를 지정해 주세요.');
        }
        return [file];
    }
    if (process.platform !== 'win32') return ['codex'];

    for (const directory of (env.Path ?? env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        const root = directory.replace(/^"|"$/g, '');
        const executable = path.join(root, 'codex.exe');
        const npmScript = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        for (const candidate of [[executable], [process.execPath, npmScript]]) {
            try {
                await access(candidate.at(-1), constants.R_OK);
                return candidate;
            } catch (error) {
                if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
            }
        }
    }
    throw new Error('Codex CLI를 설치하거나 ST_CODEX_EXECUTABLE에 실행 파일 경로를 지정해 주세요.');
}

function codexEnvironment() {
    const env = { ...process.env };
    for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[name];
    return env;
}

async function checkLogin(command, prefix, env) {
    let result;
    try {
        result = await runFile(command, [...prefix, 'login', 'status'], { env, timeout: 15_000, windowsHide: true });
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error('Codex CLI를 찾을 수 없습니다. SillyTavern 서버에서 codex 명령이 실행되는지 확인해 주세요.');
        }
        throw new Error('SillyTavern을 실행하는 OS 계정에서 codex login으로 ChatGPT에 로그인해 주세요.');
    }
    if (!/logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`)) {
        throw new Error('Codex의 ChatGPT 로그인이 필요합니다. 같은 OS 계정에서 codex login을 실행해 주세요.');
    }
}

function requestCodex(command, prefix, env, { job, prompt, model } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, [...prefix, 'app-server', '--enable', 'image_generation', '--listen', 'stdio://'], {
            cwd: job?.directory, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (job) job.child = child;
        const events = createInterface({ input: child.stdout, crlfDelay: Infinity });
        let finished = false;
        let threadId;
        let image;
        let imageFailure;
        let report;
        const models = new Map();
        const seenCursors = new Set();
        let diagnostic = '';
        let killTimer;
        let timeout = setTimeout(() => finish(new Error('Codex 앱 서버를 시작하는 데 시간이 초과되었습니다.')), 30_000);
        timeout.unref();

        function finish(error, result) {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            child.stdin.end();
            if (child.pid && child.exitCode === null && child.signalCode === null) {
                killTimer = setTimeout(() => child.kill(), 1000);
                killTimer.unref();
            }
            if (error) reject(error);
            else resolve(result);
        }

        function send(message) {
            child.stdin.write(`${JSON.stringify(message)}\n`);
        }

        events.on('line', line => {
            if (finished) return;
            let event;
            try {
                event = JSON.parse(line);
            } catch {
                return; // Launchers may print non-JSON startup notices.
            }
            if (!event || typeof event !== 'object') return;
            if (event.method && event.id != null) {
                send({ id: event.id, error: { code: -32601, message: 'This image client does not handle server requests.' } });
                return;
            }
            if ([1, 2, 3, 4].includes(event.id) && event.error) {
                finish(new Error(`Codex 응답 — ${summarizeReport(event.error.message) || 'Codex 요청을 시작하지 못했습니다.'}`));
                return;
            }
            if (event.id === 1 && event.result) {
                send({ method: 'initialized' });
                if (job) {
                    send({ id: 2, method: 'thread/start', params: {
                        cwd: job.directory, modelProvider: 'openai', model, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
                    } });
                } else {
                    send({ id: 4, method: 'model/list', params: { limit: 100, includeHidden: false } });
                }
                return;
            }
            if (event.id === 4 && event.result) {
                if (!Array.isArray(event.result.data)) {
                    finish(new Error('Codex가 모델 목록을 반환하지 않았습니다.'));
                    return;
                }
                for (const entry of event.result.data) {
                    if (typeof entry?.model !== 'string' || !modelPattern.test(entry.model) || entry.hidden) continue;
                    const name = typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName : entry.model;
                    models.set(entry.model, { id: entry.model, name });
                }
                const cursor = event.result.nextCursor;
                if (cursor && !seenCursors.has(cursor)) {
                    seenCursors.add(cursor);
                    send({ id: 4, method: 'model/list', params: { limit: 100, includeHidden: false, cursor } });
                } else {
                    finish(null, { models: [...models.values()] });
                }
                return;
            }
            if (event.id === 2 && event.result) {
                threadId = event.result.thread?.id;
                if (typeof threadId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(threadId)) {
                    finish(new Error('Codex 앱 서버에서 작업 ID를 받지 못했습니다.'));
                    return;
                }
                clearTimeout(timeout);
                timeout = setTimeout(() => finish(new Error('이미지 생성 시간이 초과되었습니다.')), generationTimeout);
                timeout.unref();
                send({ id: 3, method: 'turn/start', params: {
                    threadId,
                    input: [{ type: 'text', text: `${instruction}\n\nVisual brief:\n${prompt}`, text_elements: [] }],
                } });
                return;
            }
            if (!threadId || event.params?.threadId !== threadId) return;
            if (event.method === 'item/completed') {
                const item = event.params.item;
                if (item?.type === 'imageGeneration') {
                    if (item.status === 'completed') image = item;
                    else if (item.failure?.type === 'usageLimitExceeded') imageFailure = 'Codex 이미지 생성 사용량 한도에 도달했습니다.';
                }
                if (item?.type === 'agentMessage') report = item.text;
            }
            if (event.method === 'turn/completed') {
                const turn = event.params.turn;
                finish(null, { threadId, image, report: imageFailure || turn?.error?.message || report });
            }
        });

        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-3000); });
        child.stdin.on('error', () => {}); // Startup failures are reported when the process exits.
        child.once('error', finish);
        child.once('close', code => {
            events.close();
            clearTimeout(killTimer);
            if (job) job.child = undefined;
            if (finished) return;
            if (/read-only file system|permission denied/i.test(diagnostic)) {
                finish(new Error('Codex가 작업 파일을 쓸 수 없습니다. 서버의 Codex 홈 및 저장 폴더 권한을 확인해 주세요.'));
            } else {
                const details = summarizeReport(diagnostic);
                finish(new Error(`Codex 앱 서버가 작업을 끝내기 전에 종료됐습니다${code === null ? '' : ` (종료 코드 ${code})`}.${details ? ` Codex 응답 — ${details}` : ''}`));
            }
        });
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex_scene_image', title: 'Codex Scene Image', version: '0.1.3' } } });
    });
}

function hasPngHeader(bytes) {
    return bytes.subarray(0, 8).equals(pngSignature) && bytes.toString('ascii', 12, 16) === 'IHDR';
}

async function validatePng(file) {
    const stat = await lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.size < 33 || stat.size > maxImageBytes) return false;
    const stream = await open(file, 'r');
    try {
        const header = Buffer.alloc(16);
        await stream.read(header, 0, header.length, 0);
        return hasPngHeader(header);
    } finally {
        await stream.close();
    }
}

async function findGeneratedPng(directory) {
    const info = await lstat(directory).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
    });
    if (!info?.isDirectory()) return;
    const entries = await readdir(directory, { withFileTypes: true });
    const pngs = entries.filter(entry => entry.isFile() && /\.png$/i.test(entry.name));
    for (const entry of pngs) {
        const file = path.join(directory, entry.name);
        if (await validatePng(file)) return file;
    }
}

async function collectGeneratedPng(job, threadId, image, env) {
    if (await validatePng(job.file)) return true;

    const directories = [path.join(job.directory, 'generated_images')];
    if (threadId) {
        const configuredHome = env.CODEX_HOME?.trim();
        const codexDirectory = configuredHome ? path.resolve(job.directory, configuredHome) : path.join(homedir(), '.codex');
        directories.push(path.join(codexDirectory, 'generated_images', threadId));
    }

    const savedPath = image?.savedPath;
    const isInOutputDirectory = typeof savedPath === 'string' && path.isAbsolute(savedPath)
        && directories.some(directory => path.relative(directory, path.dirname(savedPath)) === '');
    if (isInOutputDirectory && await validatePng(savedPath)) {
        await copyFile(savedPath, job.file, constants.COPYFILE_EXCL);
        return true;
    }

    if (typeof image?.result === 'string' && image.result.length <= Math.ceil(maxImageBytes / 3) * 4) {
        const bytes = Buffer.from(image.result, 'base64');
        if (bytes.length >= 33 && bytes.length <= maxImageBytes && hasPngHeader(bytes)) {
            await writeFile(job.file, bytes, { flag: 'wx', mode: 0o600 });
            return true;
        }
    }

    for (const directory of directories) {
        const file = await findGeneratedPng(directory);
        if (file) {
            await rm(job.file, { force: true });
            await copyFile(file, job.file, constants.COPYFILE_EXCL);
            return true;
        }
    }
    return false;
}

function summarizeReport(report) {
    if (typeof report !== 'string') return '';
    return report.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

async function runJob(job, prompt, model) {
    try {
        const env = codexEnvironment();
        const [command, ...prefix] = await getCodexCommand(env);
        await checkLogin(command, prefix, env);
        await mkdir(job.directory, { recursive: true, mode: 0o700 });
        const { threadId, image, report } = await requestCodex(command, prefix, env, { job, prompt, model });
        if (!await collectGeneratedPng(job, threadId, image, env)) {
            const details = summarizeReport(report);
            throw new Error(details
                ? `이번 작업의 PNG 파일을 찾지 못했습니다. Codex 응답 — ${details}`
                : image
                    ? 'Codex가 이미지 생성 완료를 보고했지만 저장 경로나 이미지 데이터를 가져올 수 없었습니다.'
                    : '이번 작업에서 Codex의 이미지 생성 완료 응답을 받지 못했습니다.');
        }
        job.state = 'complete';
    } catch (error) {
        job.state = 'failed';
        job.error = error.message;
        await rm(job.directory, { recursive: true, force: true }).catch(() => {});
    }
}

export async function init(router) {
    router.use((req, res, next) => {
        if (!req.user?.profile?.admin || !req.user?.directories?.root) {
            return res.status(403).json({ error: '서버의 Codex CLI를 실행할 수 있는 SillyTavern 관리자 계정이 필요합니다.' });
        }
        res.set('Cache-Control', 'no-store');
        next();
    });

    router.get('/models', async (_req, res) => {
        try {
            const env = codexEnvironment();
            const [command, ...prefix] = await getCodexCommand(env);
            await checkLogin(command, prefix, env);
            return res.json(await requestCodex(command, prefix, env));
        } catch (error) {
            return res.status(503).json({ error: error.message });
        }
    });

    router.post('/jobs', (req, res) => {
        const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
        if (!prompt || prompt.length > 30_000) {
            return res.status(400).json({ error: '30,000자 이내의 이미지 프롬프트를 입력해 주세요.' });
        }
        const model = req.body?.model;
        if (model !== undefined && (typeof model !== 'string' || !modelPattern.test(model))) {
            return res.status(400).json({ error: 'Codex 모델을 다시 선택해 주세요.' });
        }
        const owner = req.user.profile.handle;
        const running = [...jobs.values()].find(job => job.owner === owner && job.state === 'running');
        if (running) return res.status(409).json({ error: '이 계정에서 이미지 생성이 이미 진행 중입니다.' });

        const id = randomUUID();
        const directory = path.resolve(req.user.directories.root, 'codex-scene-images', id);
        const job = { owner, directory, file: path.join(directory, 'image.png'), state: 'running' };
        jobs.set(id, job);
        void runJob(job, prompt, model);
        return res.status(202).json({ id });
    });

    router.get('/jobs/:id', (req, res) => {
        const job = jobs.get(req.params.id);
        if (job?.owner !== req.user.profile.handle) {
            return res.status(404).json({ state: 'failed', error: '이미지 작업을 찾을 수 없습니다.' });
        }
        return res.json({ state: job.state, error: job.error, path: job.state === 'complete' ? job.file : undefined });
    });

    router.get('/jobs/:id/image', (req, res) => {
        const job = jobs.get(req.params.id);
        if (job?.owner !== req.user.profile.handle || job.state !== 'complete') return res.sendStatus(404);
        res.type('png');
        res.set('X-Content-Type-Options', 'nosniff');
        return res.sendFile(job.file, error => {
            if (error && !res.headersSent) res.sendStatus(error.statusCode ?? 404);
        });
    });
}

export async function exit() {
    for (const job of jobs.values()) job.child?.kill();
    jobs.clear();
}
