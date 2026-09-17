/**
 * Small DOM toolkit + reusable widgets (cards, toasts, modals).
 * Everything is built with createElement/textContent — never innerHTML — so
 * user supplied names and chat messages can't inject markup.
 */

import { parseCard, RANK_LABEL, SUIT_LABEL } from '/engine/cards.js';

/** el('div', {class: 'x', onclick: fn}, [children]) */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function formatChips(value) {
  const number = Math.round(Number(value) || 0);
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (Math.abs(number) >= 10_000) return `${(number / 1000).toFixed(1)}k`;
  return number.toLocaleString('en-IN');
}

export function formatSigned(value) {
  const number = Math.round(Number(value) || 0);
  return `${number > 0 ? '+' : ''}${formatChips(number)}`;
}

/** A playing card element. Pass card = null for a face-down card. */
export function cardEl(card, { size = 'md', animate = false } = {}) {
  const label = card ? parseCard(card) : null;
  const suit = label ? label.suit : null;
  const classes = ['pcard', size];
  if (!card) classes.push('back');
  else if (suit === 'H' || suit === 'D') classes.push('red');
  if (animate) classes.push('dealt');

  const node = el('div', { class: classes.join(' ') });
  if (card) {
    const text = RANK_LABEL[label.rank];
    const suitGlyph = SUIT_LABEL[suit];
    node.append(
      el('span', { class: 'corner', text: `${text}${suitGlyph}` }),
      el('span', { class: 'pip', text: suitGlyph }),
      el('span', { class: 'corner br', text: `${text}${suitGlyph}` })
    );
    node.title = `${text} of ${suit}`;
    node.dataset.card = card;
  }
  return node;
}

export function cardRow(cards, { size = 'sm', faceDown = 0, animate = false } = {}) {
  const row = el('div', { class: 'row', style: { gap: '4px' } });
  cards.forEach((card, index) => {
    const node = cardEl(card, { size, animate });
    if (animate) {
      node.style.setProperty('--dx', `${(index - 1) * 14}px`);
      node.style.animationDelay = `${index * 70}ms`;
    }
    row.append(node);
  });
  for (let i = 0; i < faceDown; i += 1) {
    const node = cardEl(null, { size, animate });
    if (animate) node.style.animationDelay = `${(cards.length + i) * 70}ms`;
    row.append(node);
  }
  return row;
}

// ── toasts ────────────────────────────────────────────────────────────────
let toastHost = null;

export function toast(message, { kind = '', timeout = 2800 } = {}) {
  toastHost = toastHost || document.getElementById('toasts');
  if (!toastHost) return;
  const node = el('div', { class: `toast ${kind}`, text: message });
  toastHost.append(node);
  setTimeout(() => {
    node.classList.add('fade');
    setTimeout(() => node.remove(), 320);
  }, timeout);
  return node;
}

// ── modals ────────────────────────────────────────────────────────────────
const modalStack = [];

export function openModal({ title, icon = '', body, actions = [], onClose, dismissible = true }) {
  const root = document.getElementById('modal-root');
  const backdrop = el('div', { class: 'modal-backdrop' });
  const close = () => closeModal(backdrop);

  const modal = el('div', { class: 'modal' }, [
    el('header', {}, [
      icon ? el('span', { style: { fontSize: '20px' }, text: icon }) : null,
      el('h3', { text: title }),
      el('div', { class: 'spacer' }),
      dismissible ? el('button', { class: 'btn small icon close', text: '✕', onclick: close }) : null
    ]),
    ...[].concat(body || []).filter(Boolean),
    actions.length
      ? el('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '10px' } }, actions.map((action) => el('button', {
          class: `btn ${action.kind || ''}`,
          text: action.label,
          onclick: () => {
            const keepOpen = action.onClick?.();
            if (keepOpen !== true) close();
          }
        })))
      : null
  ]);

  backdrop.append(modal);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop && dismissible) close();
  });
  root.append(backdrop);
  modalStack.push({ backdrop, onClose });
  return backdrop;
}

export function closeModal(node) {
  const entry = node ? modalStack.find((item) => item.backdrop === node) : modalStack[modalStack.length - 1];
  if (!entry) return false;
  entry.backdrop.remove();
  modalStack.splice(modalStack.indexOf(entry), 1);
  entry.onClose?.();
  return true;
}

export function closeTopModal() {
  const entry = modalStack.pop();
  if (!entry) return false;
  entry.backdrop.remove();
  entry.onClose?.();
  return true;
}

/**
 * A shareable link for a table.
 * @param {string} tableId
 * @param {string} [base] origin to build it on — pass the LAN/public address
 *        when the host is browsing on localhost, otherwise the friend would
 *        receive a link to their own machine.
 */
export function inviteLink(tableId, base) {
  const href = base || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4000');
  const url = new URL(href, 'http://localhost:4000');
  url.searchParams.set('table', tableId);
  return url.toString();
}

/** True when the page is being viewed on the host machine itself. */
export function isLocalHost() {
  if (typeof window === 'undefined') return true;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

export function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = el('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
  return Promise.resolve();
}

export function relativeTime(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
