import { configChangeEmitter, configRead } from '../config.js';

configChangeEmitter.addEventListener('configChange', (event) => {
    const { key, value } = event.detail;
    if (key === 'enableWhoIsWatchingMenu') {
        disableWhosWatching(value);
    }
});

let interval;

function disableWhosWatching(value) {
    try {
        if (!window.localStorage) return;
        const stored = localStorage['yt.leanback.default::recurring_actions'];
        if (!stored || stored === 'undefined' || stored === 'null') return;
        const LeanbackRecurringActions = JSON.parse(stored);
        if (!LeanbackRecurringActions || !LeanbackRecurringActions.data || !LeanbackRecurringActions.data.data) return;

        const shouldPermanentlyEnable = configRead('permanentlyEnableWhoIsWatchingMenu');
        const date = new Date();
        if (!value) {
            // Setting it after 7 days should be enough, as it'll get executed every time the app launches.
            date.setDate(date.getDate() + 7);
            if (LeanbackRecurringActions.data.data["startup-screen-account-selector-with-guest"]) {
                LeanbackRecurringActions.data.data["startup-screen-account-selector-with-guest"].lastFired = date.getTime();
            }
            if (LeanbackRecurringActions.data.data.whos_watching_fullscreen_zero_accounts) {
                LeanbackRecurringActions.data.data.whos_watching_fullscreen_zero_accounts.lastFired = date.getTime();
            }
            if (LeanbackRecurringActions.data.data["startup-screen-signed-out-welcome-back"]) {
                LeanbackRecurringActions.data.data["startup-screen-signed-out-welcome-back"].lastFired = date.getTime();
            }
            localStorage['yt.leanback.default::recurring_actions'] = JSON.stringify(LeanbackRecurringActions);
        } else {
            // Do nothing if the last fired action is less than 2 hours ago.
            const guestSelector = LeanbackRecurringActions.data.data["startup-screen-account-selector-with-guest"];
            if (guestSelector && date.getTime() - guestSelector.lastFired > 0 && date.getTime() - guestSelector.lastFired < 2 * 60 * 60 * 1000
            && !shouldPermanentlyEnable) {
                return;
            }
            function setActions() {
                if (LeanbackRecurringActions.data.data["startup-screen-account-selector-with-guest"]) {
                    LeanbackRecurringActions.data.data["startup-screen-account-selector-with-guest"].lastFired = date.getTime();
                }
                if (LeanbackRecurringActions.data.data.whos_watching_fullscreen_zero_accounts) {
                    LeanbackRecurringActions.data.data.whos_watching_fullscreen_zero_accounts.lastFired = date.getTime();
                }
                if (LeanbackRecurringActions.data.data["startup-screen-signed-out-welcome-back"]) {
                    LeanbackRecurringActions.data.data["startup-screen-signed-out-welcome-back"].lastFired = date.getTime();
                }
                localStorage['yt.leanback.default::recurring_actions'] = JSON.stringify(LeanbackRecurringActions);
            }
            setActions();
            if (shouldPermanentlyEnable) {
                date.setDate(date.getDate() - 7);
                setActions();
                interval = setInterval(setActions, 60 * 1000);
            } else if (interval) clearInterval(interval);
        }
    } catch (e) {
        console.warn('[PulseTube TV] Failed to disable Who\'s Watching menu:', e.message);
    }
}

try {
    disableWhosWatching(configRead('enableWhoIsWatchingMenu'));
} catch (e) {
    console.warn('[PulseTube TV] Failed to initialize disableWhosWatching:', e.message);
}