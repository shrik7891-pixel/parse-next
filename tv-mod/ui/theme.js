import { configRead } from '../config.js';

const style = document.createElement('style');
try {
    const nonceEl = document.querySelector('[nonce]');
    if (nonceEl) {
        style.setAttribute('nonce', nonceEl.getAttribute('nonce'));
    }
} catch (e) {
    console.warn('[PulseTube TV] Failed to set nonce on theme style:', e);
}
let css = '';

function updateStyle() {
    css = `
    ytlr-guide-response yt-focus-container {
        background-color: ${configRead('focusContainerColor')};
    }

    #container {
        background-color: ${configRead('routeColor')} !important;
    }
`;
    const existingStyle = document.querySelector('style[nonce]');
    if (existingStyle) {
        existingStyle.textContent += css;
    } else {
        style.textContent = css;
    }
};

document.head.appendChild(style);
updateStyle();
export default updateStyle;