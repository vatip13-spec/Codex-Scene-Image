import { buildPrompt, defaultImageStyle, getCharacterMaterials, getSceneLore, imageStyles } from './prompt.js';

const pluginUrl = '/api/plugins/codex-scene-image';
const menuId = 'codex-scene-image-menu';
const settingsKey = 'codexSceneImage';
const draftResponseLength = 2400;

async function request(path, body) {
    const headers = SillyTavern.getContext().getRequestHeaders();
    const response = await fetch(`${pluginUrl}${path}`, body === undefined
        ? { headers, cache: 'no-store' }
        : { method: 'POST', headers, body: JSON.stringify(body) });
    if (response.status === 404 && !response.headers.get('Content-Type')?.includes('json')) {
        throw new Error('서버 플러그인을 설치하고 SillyTavern을 재시작해 주세요.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw Object.assign(new Error(data.error || `서버 요청 실패 (${response.status})`), { status: response.status });
    }
    return data;
}

function createDialog() {
    const dialog = document.createElement('dialog');
    dialog.className = 'codex-scene-dialog';
    dialog.setAttribute('aria-labelledby', 'codex-scene-title');
    dialog.innerHTML = `
        <header class="codex-scene-header">
            <h2 id="codex-scene-title">장면 이미지 생성</h2>
            <button type="button" class="menu_button" data-close aria-label="닫기">닫기</button>
        </header>
        <label class="codex-scene-label">기준 메시지
            <select class="text_pole" data-scene></select>
        </label>
        <label class="codex-scene-label">이미지 스타일
            <select class="text_pole" data-image-style></select>
        </label>
        <div class="codex-scene-profile-row">
            <button type="button" class="menu_button" data-draft>이미지 프롬프트 받기</button>
            <label class="codex-scene-label">프롬프트 작성용 연결 프로필
                <select class="text_pole" data-draft-profile></select>
            </label>
        </div>
        <label class="codex-scene-label">영어 이미지 프롬프트
            <textarea class="text_pole" data-english rows="6" spellcheck="false"></textarea>
        </label>
        <div class="codex-scene-profile-row">
            <button type="button" class="menu_button" data-translate>번역하기</button>
            <label class="codex-scene-label">번역용 연결 프로필
                <select class="text_pole" data-profile></select>
            </label>
        </div>
        <label class="codex-scene-label">한국어 번역 (검수용)
            <textarea class="text_pole" data-korean rows="6"></textarea>
        </label>
        <small>이미지 생성에는 위쪽 영어 프롬프트를 사용합니다.</small>
        <label class="codex-scene-label">Codex 모델
            <select class="text_pole" data-codex-model>
                <option value="">Codex 기본값</option>
            </select>
        </label>
        <small data-model-status role="status" hidden></small>
        <button type="button" class="menu_button" data-generate>이미지 생성</button>
        <div data-status role="status" aria-live="polite"></div>
        <figure data-preview hidden>
            <img alt="생성한 장면 이미지">
            <figcaption><a target="_blank" rel="noopener" data-image-link>원본 열기</a>
                <span data-path></span>
            </figcaption>
        </figure>
        <button type="button" class="menu_button codex-scene-close-bottom" data-close>닫기</button>`;
    document.body.append(dialog);
    return dialog;
}

let popup;

function openDialog() {
    if (!popup) popup = initializeDialog();
    popup.open();
}

function initializeDialog() {
    const dialog = createDialog();
    const scene = dialog.querySelector('[data-scene]');
    const imageStyle = dialog.querySelector('[data-image-style]');
    imageStyle.replaceChildren(...Object.entries(imageStyles).map(([id, style]) => new Option(style.label, id)));
    const draft = dialog.querySelector('[data-draft]');
    const draftProfile = dialog.querySelector('[data-draft-profile]');
    const english = dialog.querySelector('[data-english]');
    const profile = dialog.querySelector('[data-profile]');
    const translate = dialog.querySelector('[data-translate]');
    const korean = dialog.querySelector('[data-korean]');
    const model = dialog.querySelector('[data-codex-model]');
    const modelStatus = dialog.querySelector('[data-model-status]');
    const generate = dialog.querySelector('[data-generate]');
    const status = dialog.querySelector('[data-status]');
    const preview = dialog.querySelector('[data-preview]');
    let messages = [];
    let materials = '';
    let chatKey;
    let busy = false;
    let imageJob;
    let loadingModels = false;
    let modelsLoaded = false;

    function refreshButtons() {
        draft.disabled = busy || !messages.length;
        translate.disabled = busy || !english.value.trim() || !profile.value;
        generate.disabled = busy || !english.value.trim();
        scene.disabled = busy || !messages.length;
        imageStyle.disabled = busy;
        draftProfile.disabled = busy || draftProfile.options.length < 2;
        profile.disabled = busy || profile.options.length < 2;
        model.disabled = busy || loadingModels || model.options.length < 2;
        english.readOnly = busy;
        korean.readOnly = busy;
    }

    async function loadModels() {
        if (modelsLoaded || loadingModels) return;
        const context = SillyTavern.getContext();
        const saved = context.extensionSettings?.[settingsKey]?.codexModel;
        model.replaceChildren(new Option('Codex 기본값', ''));
        if (saved) model.add(new Option(saved, saved, true, true));
        loadingModels = true;
        modelStatus.hidden = false;
        modelStatus.textContent = 'Codex 모델 목록을 불러오는 중…';
        refreshButtons();
        try {
            const result = await request('/models');
            model.replaceChildren(
                new Option('Codex 기본값', ''),
                ...result.models.map(item => new Option(item.name, item.id)),
            );
            if (result.models.some(item => item.id === saved)) {
                model.value = saved;
            } else if (saved) {
                modelStatus.textContent = `저장한 모델(${saved})이 목록에 없어 Codex 기본값이 선택됐습니다.`;
            }
            if (!result.models.length) modelStatus.textContent = '선택할 모델이 없어 Codex 기본값을 사용합니다.';
            modelStatus.hidden = Boolean(result.models.length && (!saved || model.value));
            modelsLoaded = true;
        } catch (error) {
            modelStatus.textContent = `모델 목록을 가져오지 못했습니다. ${error.message}`;
        } finally {
            loadingModels = false;
            refreshButtons();
        }
    }

    async function run(label, action) {
        if (busy) return;
        busy = true;
        status.dataset.error = 'false';
        status.textContent = label;
        refreshButtons();
        try {
            status.textContent = await action();
        } catch (error) {
            status.dataset.error = 'true';
            status.textContent = error.message || '요청에 실패했습니다.';
        } finally {
            busy = false;
            refreshButtons();
        }
    }

    draft.onclick = () => run('이미지 프롬프트를 작성하고 있습니다…', async () => {
        const context = SillyTavern.getContext();
        const selectedIndex = Number(scene.value);
        const sceneLore = await getSceneLore(context, messages, selectedIndex);
        const prompt = buildPrompt(materials, messages, selectedIndex, imageStyle.value, sceneLore);
        const profileId = draftProfile.value;
        const response = profileId
            ? (await context.ConnectionManagerRequestService.sendRequest(profileId, [
                { role: 'user', content: prompt },
            ], draftResponseLength, { extractData: true, includePreset: true, stream: false }))?.content
            : await context.generateRaw({ prompt, api: context.mainApi, trimNames: false, responseLength: draftResponseLength });
        const text = typeof response === 'string' ? response.trim() : '';
        if (!text) throw new Error('프롬프트 작성 모델이 빈 응답을 반환했습니다.');
        english.value = text;
        korean.value = '';
        return '영어 프롬프트를 작성했습니다.';
    });

    translate.onclick = () => run('번역하고 있습니다…', async () => {
        const { ConnectionManagerRequestService } = SillyTavern.getContext();
        const result = await ConnectionManagerRequestService.sendRequest(profile.value, [
            { role: 'system', content: 'Translate the image-generation prompt into natural Korean. Preserve the visual details, pose, composition, and names. Return only the translation.' },
            { role: 'user', content: english.value },
        ], 2000, { extractData: true, includePreset: true, stream: false });
        const translation = result?.content?.trim();
        if (!translation) throw new Error('번역 모델이 빈 응답을 반환했습니다.');
        korean.value = translation;
        return '번역했습니다. 아래 텍스트를 직접 수정할 수 있습니다.';
    });

    generate.onclick = () => run('Codex에서 이미지를 생성하고 있습니다…', async () => {
        if (!imageJob) imageJob = (await request('/jobs', { prompt: english.value, model: model.value || undefined })).id;
        for (;;) {
            let result;
            try {
                result = await request(`/jobs/${imageJob}`);
            } catch (error) {
                if (error.status === 404 || error.status === 403) {
                    imageJob = undefined;
                    throw error;
                }
                throw new Error(`${error.message} 이미지 생성 버튼을 다시 누르면 기존 작업 상태를 확인합니다.`);
            }
            if (result.state === 'failed') {
                imageJob = undefined;
                throw new Error(result.error);
            }
            if (result.state === 'complete') {
                const url = `${pluginUrl}/jobs/${imageJob}/image`;
                preview.querySelector('img').src = url;
                preview.querySelector('[data-image-link]').href = url;
                preview.querySelector('[data-path]').textContent = result.path;
                preview.hidden = false;
                imageJob = undefined;
                return '이미지를 생성했습니다.';
            }
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    });

    english.oninput = refreshButtons;
    function saveSetting(name, value) {
        const context = SillyTavern.getContext();
        context.extensionSettings[settingsKey] ??= {};
        context.extensionSettings[settingsKey][name] = value;
        context.saveSettingsDebounced();
    }

    draftProfile.onchange = () => saveSetting('draftProfile', draftProfile.value);
    imageStyle.onchange = () => saveSetting('imageStyle', imageStyle.value);
    profile.onchange = () => {
        saveSetting('translationProfile', profile.value);
        refreshButtons();
    };
    model.onchange = () => {
        saveSetting('codexModel', model.value);
        if (modelsLoaded) modelStatus.hidden = true;
    };
    dialog.querySelectorAll('[data-close]').forEach(button => {
        button.onclick = () => dialog.close();
    });

    return {
        open() {
            if (dialog.open) return;
            if (!busy && !imageJob) {
                const context = SillyTavern.getContext();
                let profiles = [];
                try {
                    profiles = context.ConnectionManagerRequestService?.getSupportedProfiles() ?? [];
                } catch {
                    // The optional built-in Connection Profiles extension may be disabled.
                }
                const settings = context.extensionSettings?.[settingsKey];
                imageStyle.value = Object.hasOwn(imageStyles, settings?.imageStyle) ? settings.imageStyle : defaultImageStyle;
                for (const [select, label, saved] of [
                    [draftProfile, '현재 RP 모델', settings?.draftProfile],
                    [profile, profiles.length ? '연결 프로필 선택' : '사용 가능한 연결 프로필이 없습니다', settings?.translationProfile],
                ]) {
                    select.replaceChildren(new Option(label, ''), ...profiles.map(item => new Option(item.name, item.id)));
                    select.value = profiles.some(item => item.id === saved) ? saved : '';
                }
                const key = JSON.stringify([context.characterId, context.groupId, context.chatId]);
                if (key !== chatKey) {
                    english.value = '';
                    korean.value = '';
                    status.textContent = '';
                    preview.hidden = true;
                    chatKey = key;
                }
                materials = getCharacterMaterials(context);
                messages = (context.chat ?? []).filter(message => !message.is_system && typeof message.mes === 'string' && message.mes.trim());
                scene.replaceChildren(...messages.map((message, index) => new Option(
                    `${message.name || '메시지'} · ${message.mes.replace(/\s+/g, ' ').trim().slice(0, 90)}`, index,
                )).reverse());
                if (!messages.length) scene.add(new Option('선택할 메시지가 없습니다', ''));
            }
            refreshButtons();
            dialog.showModal();
            void loadModels();
        },
    };
}

function mountMenu() {
    const menu = document.querySelector('#extensionsMenu');
    if (!menu || document.getElementById(menuId)) return Boolean(menu);
    const button = document.createElement('button');
    button.type = 'button';
    button.id = menuId;
    button.className = 'list-group-item flex-container flexGap5';
    button.innerHTML = '<span class="fa-solid fa-image" aria-hidden="true"></span><span>이미지 생성 (Codex)</span>';
    button.addEventListener('click', openDialog);
    menu.append(button);
    return true;
}

export function init() {
    if (mountMenu()) return;
    const observer = new MutationObserver(() => {
        if (mountMenu()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
