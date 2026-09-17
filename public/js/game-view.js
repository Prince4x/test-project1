/**
 * Table view — renders engine snapshots onto the felt and wires up the action
 * bar, drawers, chat, sounds and animations.
 *
 * The view is deliberately controller-agnostic: practice mode and online
 * multiplayer both hand it the same snapshot/event shape.
 */

import { PHASE, ACTION, raiseCostFor } from '/engine/table.js';
import { CATEGORY_LABEL } from '/engine/evaluator.js';
import { el, $, $$, cardEl, cardRow, toast, openModal, closeModal, formatChips, formatSigned, relativeTime, inviteLink, copyToClipboard } from '/js/ui.js';

const RING = (count) => {
  const positions = [];
  for (let i = 0; i < Math.max(count, 1); i += 1) {
    const theta = ((90 - (i * 360) / Math.max(count, 1)) * Math.PI) / 180;
    positions.push({ left: 50 + 40 * Math.cos(theta), top: 50 + 41 * Math.sin(theta) });
  }
  return positions;
};

const ACTION_TEXT = {
  blind: 'played blind',
  chaal: 'chaal',
  raise: 'raised',
  allin: 'all-in',
  pack: 'packed',
  check: 'checked',
  show: 'showed',
  sideshow: 'side show',
  see: 'saw cards'
};

const REACTIONS = ['👍', '😂', '😮', '🔥', '🎉', '😭', '🤝', '🃏'];

/** Chat messages that are nothing but emoji float over the sender's seat. */
function isEmojiOnly(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 6 && /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u.test(trimmed);
}

export class GameView {
  constructor({ store, sound, callbacks = {} }) {
    this.store = store;
    this.sound = sound;
    this.callbacks = callbacks;       // { onLeave, onOpenSettings, onFillBots, onAddBot, onRemoveBot }
    this.controller = null;
    this.snapshot = null;
    this.tableInfo = null;
    this.seats = new Map();           // playerId -> { el, refs, prev }
    this.seatShells = [];
    this.countdownTimer = null;
    this.chatLog = [];
    this.lastHandAnimated = 0;
    this.lastWinner = null;
    this.raiseValue = 0;
    this.spectating = false;
  }

  mount() {
    this.els = {
      screen: $('#game'),
      tableName: $('#game-table-name'),
      tableMeta: $('#game-table-meta'),
      pot: $('#game-pot'),
      potValue: $('#pot-value'),
      potChips: $('#pot-chips'),
      potDisplay: $('#pot-display'),
      stake: $('#game-stake'),
      round: $('#game-round'),
      chips: $('#game-chips'),
      seats: $('#seats'),
      dealArea: $('#deal-area'),
      winnerHost: $('#winner-banner-host'),
      myCards: $('#my-cards'),
      myHandName: $('#my-hand-name'),
      myHandNote: $('#my-hand-note'),
      actionBar: $('#action-bar'),
      chatBody: $('#chat-body'),
      chatInput: $('#chat-input'),
      reactionBar: $('#reaction-bar'),
      historyBody: $('#history-body'),
      rankingsBody: $('#rankings-body'),
      tableArea: $('#table-area')
    };

    $('#btn-leave').onclick = () => this.callbacks.onLeave?.();
    $('#btn-rankings').onclick = () => this.toggleDrawer('rankings-drawer');
    $('#btn-history').onclick = () => this.toggleDrawer('log-drawer');
    $('#btn-chat').onclick = () => this.toggleDrawer('chat-drawer');
    $('#btn-settings-game').onclick = () => this.callbacks.onOpenSettings?.();
    $$('[data-close-drawer]').forEach((button) => {
      button.onclick = () => this.closeDrawers();
    });
    $('#chat-send').onclick = () => this.sendChat();
    this.els.chatInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.sendChat();
    });
    this.els.reactionBar.replaceChildren(...REACTIONS.map((emoji) => el('button', {
      text: emoji,
      title: `Send ${emoji}`,
      onclick: () => this.sendReaction(emoji)
    })));
    this.renderRankings();
    this.renderChat();
    return this;
  }

  setController(controller) {
    this.controller = controller;
    this.seatShells = [];
    this.seats.clear();
    this.els.seats.replaceChildren();
    this.chatLog = [];
    this.els.chatBody.replaceChildren();
    this.els.winnerHost.replaceChildren();
    this.els.dealArea.replaceChildren();
  }

  // ───────────────────────────────────────────────────────── presentation ──

  render(snapshot, tableInfo) {
    if (!snapshot) return;
    const previous = this.snapshot;
    this.snapshot = snapshot;
    if (tableInfo) this.tableInfo = tableInfo;

    const hand = {
      name: snapshot.name,
      boot: snapshot.config.boot,
      handNo: snapshot.handNo,
      phase: snapshot.phase
    };
    this.els.tableName.textContent = `${hand.name}${snapshot.you?.sittingOut ? ' · spectating' : ''}`;
    this.els.tableMeta.textContent = `Hand #${hand.handNo} · boot ${hand.boot} · ${snapshot.you?.seat != null ? `seat ${snapshot.you.seat + 1}` : 'no seat'}`;
    this.els.pot.textContent = `Pot ${formatChips(snapshot.pot)}`;
    this.els.potValue.textContent = formatChips(snapshot.pot);
    this.els.stake.textContent = `Stake ${formatChips(snapshot.stake)}`;
    this.els.round.textContent = `Round ${Math.min(snapshot.round, snapshot.maxRounds)}/${snapshot.maxRounds}`;
    this.els.chips.textContent = `💠 ${formatChips(snapshot.you?.chips ?? 0)}`;

    if (previous && snapshot.pot > previous.pot) {
      this.els.potDisplay.classList.remove('bump');
      void this.els.potDisplay.offsetWidth;
      this.els.potDisplay.classList.add('bump');
    }
    this.renderPotChips(snapshot.pot);
    this.renderSeats(snapshot);
    this.renderMyArea(snapshot);
    this.renderActionBar(snapshot);
    this.renderHistory(snapshot);
    this.startCountdown(snapshot);
  }

  renderPotChips(pot) {
    const denominations = [500, 100, 50, 10, 5];
    const chips = [];
    let left = Math.min(pot, 3000);
    for (const value of denominations) {
      const count = Math.min(4, Math.floor(left / value));
      for (let i = 0; i < count; i += 1) chips.push(value);
      left -= count * value;
      if (chips.length >= 8) break;
    }
    if (!chips.length && pot > 0) chips.push(5);
    this.els.potChips.replaceChildren(...chips.slice(0, 8).map((value) => el('div', { class: `chip c${value}` })));
  }

  ringFor(snapshot) {
    const seated = snapshot.seats.map((seat, index) => (seat ? { ...seat, index } : null)).filter(Boolean);
    const mySeat = snapshot.you?.seat ?? seated[0]?.index ?? 0;
    // Rotate so the viewer always sits at the bottom of the ring.
    const ordered = [...seated].sort((a, b) => {
      const total = snapshot.seats.length;
      const offset = (seat, base) => (seat - base + total) % total;
      const diff = offset(a.index, mySeat) - offset(b.index, mySeat);
      return diff || a.index - b.index;
    });
    const positions = RING(ordered.length);
    return ordered.map((seat, index) => ({ seat, position: positions[index] }));
  }

  renderSeats(snapshot) {
    const ring = this.ringFor(snapshot);
    const signature = ring.map((entry) => entry.seat.id).join('|');
    if (signature !== this.seatSignature) {
      this.seatSignature = signature;
      this.seats.clear();
      this.els.seats.replaceChildren();
      for (const { seat, position } of ring) {
        const node = this.buildSeat(seat, position);
        this.seats.set(seat.id, node);
        this.els.seats.append(node.el);
      }
    }

    const winners = new Set((snapshot.results?.winners || []).map((winner) => winner.id));
    const showdownHands = new Map((snapshot.results?.reveal || []).map((entry) => [entry.id, entry]));

    for (const { seat, position } of ring) {
      const node = this.seats.get(seat.id);
      if (!node) continue;
      node.el.style.left = `${position.left}%`;
      node.el.style.top = `${position.top}%`;
      node.el.classList.toggle('turn', Boolean(seat.isTurn));
      node.el.classList.toggle('folded', seat.packed);
      node.el.classList.toggle('out', !seat.inHand || seat.sittingOut);
      node.el.classList.toggle('winner', winners.has(seat.id));

      node.refs.avatar.textContent = seat.avatar;
      node.refs.name.textContent = seat.name;
      node.refs.name.title = seat.isBot
        ? `${seat.name} · AI opponent`
        : seat.connected ? seat.name : `${seat.name} · disconnected`;
      node.refs.chips.textContent = seat.sittingOut ? 'out of chips' : `💠 ${formatChips(seat.chips)}`;

      // badges
      const badges = [];
      if (seat.isDealer) badges.push(el('span', { class: 'tag dealer', text: 'D' }));
      if (seat.inHand && !seat.packed) {
        badges.push(el('span', { class: `tag ${seat.seen ? 'seen' : 'blind'}`, text: seat.seen ? 'seen' : 'blind' }));
      }
      if (seat.allIn) badges.push(el('span', { class: 'tag allin', text: 'all-in' }));
      if (seat.packed && seat.inHand) badges.push(el('span', { class: 'tag packed', text: 'packed' }));
      if (seat.isBot) badges.push(el('span', { class: 'tag', text: 'AI' }));
      if (!seat.connected && !seat.isBot) badges.push(el('span', { class: 'tag offline', text: 'offline' }));
      node.refs.badges.replaceChildren(...badges);

      // committed chips bubble
      if (seat.committed > 0 && seat.inHand) {
        node.refs.bubble.textContent = `◈ ${formatChips(seat.committed)}`;
        node.refs.bubble.hidden = false;
      } else {
        node.refs.bubble.hidden = true;
      }

      // cards
      const faces = seat.cards || [];
      const previousCount = node.prev?.faceCount ?? 0;
      const previousPacked = node.prev?.packed;
      node.refs.hand.replaceChildren(...this.seatCards(seat, faces, previousCount));
      node.refs.hand.hidden = !seat.inHand || (seat.packed && !faces.length);
      if (faces.length === 3 && previousCount < 3) {
        this.sound.flip();
      }
      if (seat.packed && !previousPacked && previousCount >= 0 && snapshot.phase === PHASE.SETTLED) {
        node.refs.hand.classList.add('dim');
      }

      // status line under the seat
      let status = '';
      if (seat.sittingOut) status = 'sat out — needs chips';
      else if (!seat.inHand) status = seat.connected ? 'waiting' : 'disconnected';
      else if (seat.packed) status = 'packed';
      else if (seat.allIn) status = 'all in';
      else if (seat.lastAction) status = `last: ${ACTION_TEXT[seat.lastAction] || seat.lastAction}`;
      const revealed = showdownHands.get(seat.id);
      node.refs.status.textContent = revealed ? revealed.hand.text : status;

      // turn ring (SVG has no `hidden` property — toggle display instead)
      node.refs.ring.style.display = seat.isTurn ? '' : 'none';
      node.prev = { faceCount: faces.length, packed: seat.packed };
    }

    // empty seat actions (practice: add bots; online: invite)
    const seatedCount = snapshot.seats.filter(Boolean).length;
    if (seatedCount < snapshot.maxPlayers) {
      const emptyEl = this.seats.get('__empty');
      if (!emptyEl) {
        const node = el('div', { class: 'seat', style: { left: '22%', top: '50%', opacity: '0.8' } });
        const button = el('button', { class: 'btn small ghost', text: this.controller?.isOnline ? '＋ Invite players' : '＋ Add AI player' });
        button.onclick = () => {
          if (this.controller?.isOnline) this.callbacks.onInvite?.();
          else this.callbacks.onAddBot?.();
        };
        node.append(el('div', { class: 'seat-card', style: { justifyContent: 'center' } }, [button]));
        this.els.seats.append(node);
        this.seats.set('__empty', { el: node, refs: {} });
      }
    } else if (this.seats.has('__empty')) {
      this.seats.get('__empty').el.remove();
      this.seats.delete('__empty');
    }
  }

  seatCards(seat, faces, previousCount) {
    if (!seat.inHand) return [];
    if (faces.length === 3) {
      return faces.map((card, index) => {
        const node = cardEl(card, { size: 'sm' });
        if (previousCount < 3) {
          node.classList.add('flip');
          node.style.animationDelay = `${index * 90}ms`;
        }
        return node;
      });
    }
    return [0, 1, 2].map((index) => {
      const node = cardEl(null, { size: 'sm', animate: previousCount === 0 });
      node.style.setProperty('--dx', '-120px');
      node.style.setProperty('--dy', '-40px');
      node.style.animationDelay = `${index * 90}ms`;
      return node;
    });
  }

  buildSeat(seat, position) {
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ring.setAttribute('viewBox', '0 0 50 50');
    ring.setAttribute('class', 'timer-ring');
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.setAttribute('class', 'track');
    track.setAttribute('cx', '25');
    track.setAttribute('cy', '25');
    track.setAttribute('r', '22');
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    bar.setAttribute('class', 'bar');
    bar.setAttribute('cx', '25');
    bar.setAttribute('cy', '25');
    bar.setAttribute('r', '22');
    const circumference = 2 * Math.PI * 22;
    bar.setAttribute('stroke-dasharray', `${circumference}`);
    bar.setAttribute('stroke-dashoffset', `${circumference}`);
    bar.setAttribute('transform', 'rotate(-90 25 25)');
    ring.append(track, bar);

    const avatar = el('div', { class: 'avatar', text: seat.avatar }, [ring]);
    const name = el('b', { text: seat.name });
    const chips = el('div', { class: 'chips', text: `💠 ${formatChips(seat.chips)}` });
    const badges = el('div', { class: 'badges' });
    const bubble = el('div', { class: 'bet-bubble', hidden: true });
    const hand = el('div', { class: 'seat-hand' });
    const status = el('div', { class: 'stack', style: { color: 'var(--text-faint)' } });

    const node = el('div', { class: 'seat', style: { left: `${position.left}%`, top: `${position.top}%` } }, [
      el('div', { class: 'seat-card' }, [
        avatar,
        el('div', { class: 'who' }, [name, chips]),
        badges,
        bubble
      ]),
      hand,
      el('div', { class: 'seat-meta' }, [status])
    ]);

    return { el: node, refs: { avatar, name, chips, badges, bubble, hand, status, ring } };
  }

  renderMyArea(snapshot) {
    const you = snapshot.you;
    if (!you) return;
    const seatsView = snapshot.seats[you.seat];
    const faces = you.cards?.length === 3 ? you.cards : [];

    if (!faces.length) {
      const hidden = Math.max(you.cardCount || 0, 0) || (you.inHand ? 3 : 0);
      this.els.myCards.replaceChildren(...Array.from({ length: hidden }, () => cardEl(null, { size: 'lg' })));
    } else {
      this.els.myCards.replaceChildren(...faces.map((card, index) => {
        const node = cardEl(card, { size: 'lg' });
        node.classList.add('flip');
        node.style.animationDelay = `${index * 80}ms`;
        return node;
      }));
    }

    const hand = you.hand;
    if (!you.inHand) {
      this.els.myHandName.textContent = you.sittingOut ? 'Out of chips' : 'Waiting for the next hand';
      this.els.myHandNote.textContent = you.sittingOut ? 'Buy in to be dealt in' : 'The table deals again automatically';
      this.els.myHandName.style.color = 'var(--text-dim)';
    } else if (faces.length === 3 && hand) {
      this.els.myHandName.textContent = hand.text;
      this.els.myHandName.style.color = hand.category >= 4 ? 'var(--gold)' : 'var(--text)';
      const advice = this.adviceFor(hand, snapshot);
      this.els.myHandNote.textContent = this.store.settings.hints
        ? advice
        : CATEGORY_LABEL[hand.category] || hand.label || '';
    } else if (you.inHand && !you.seen) {
      this.els.myHandName.textContent = 'Playing blind 👁';
      this.els.myHandName.style.color = 'var(--blue)';
      this.els.myHandNote.textContent = `Blind bets cost half (${formatChips(snapshot.blindCost)}) — see your cards any time`;
    } else {
      this.els.myHandName.textContent = seatsView?.packed ? 'You packed this hand' : 'No cards';
      this.els.myHandNote.textContent = '';
    }
  }

  adviceFor(hand, snapshot) {
    const strength = hand.strength ?? 0;
    const cost = snapshot.you.costToCall;
    if (strength > 0.85) return 'Monster hand — build the pot with a raise.';
    if (strength > 0.6) return `Strong — chaal ${formatChips(cost)} or raise; side show is available when 3+ players remain.`;
    if (strength > 0.35) return `Playable — a call costs ${formatChips(cost)}.`;
    if (snapshot.you.seen && snapshot.you.chips > 0) return `Weak hand — pack (fold) unless you fancy a bluff.`;
    return 'Cautious — chud pack if the betting gets heavy.';
  }

  renderActionBar(snapshot) {
    const you = snapshot.you;
    const bar = this.els.actionBar;

    if (!you) {
      bar.replaceChildren(el('div', { class: 'turn-banner waiting' }, [el('span', { text: 'Joining the table…' })]));
      return;
    }

    if (!you.inHand) {
      const nodes = [el('div', { class: 'turn-banner waiting' }, [
        el('span', { class: 'dot' }),
        el('span', { text: you.sittingOut ? 'Out of chips — buy in to rejoin' : 'Waiting for the next hand…' })
      ])];
      if (you.options?.rebuy) {
        nodes.push(el('button', {
          class: 'btn primary',
          text: `💠 Buy in ${formatChips(snapshot.config.startChips)}`,
          onclick: () => this.callbacks.onRebuy?.(snapshot.config.startChips)
        }));
      }
      bar.replaceChildren(...nodes);
      return;
    }

    if (snapshot.sideShow?.iAmTarget) {
      bar.replaceChildren(
        el('div', { class: 'turn-banner' }, [
          el('span', { text: `${snapshot.sideShow.requesterId === you.id ? 'Your' : 'A'} side show request — accept to compare hands?` })
        ]),
        el('button', { class: 'btn action show', text: 'Accept', onclick: () => this.act('sideshow-accept') }),
        el('button', { class: 'btn action pack', text: 'Decline', onclick: () => this.act('sideshow-decline') })
      );
      return;
    }

    if (!you.canAct) {
      const turnSeat = snapshot.seats.find((seat) => seat?.isTurn);
      bar.replaceChildren(el('div', { class: 'turn-banner waiting' }, [
        el('span', { class: 'dot' }),
        el('span', { text: turnSeat ? `${turnSeat.isBot ? '🤖 ' : ''}${turnSeat.name} is thinking…` : 'Dealing the next hand…' })
      ]));
      if (this.store.settings.hints && you.seen && you.hand) {
        bar.append(el('span', { class: 'pill blue', text: `Your hand: ${you.hand.text}` }));
      }
      return;
    }

    const options = you.options;
    const nodes = [];

    if (options.see) {
      nodes.push(el('div', { class: 'group' }, [
        el('button', {
          class: 'btn action show',
          onclick: () => this.act(ACTION.SEE)
        }, [el('span', { text: '👁 See cards' }), el('span', { class: 'sub', text: 'then bet at full rate' })])
      ]));
    }

    const actionGroup = el('div', { class: 'group' }, [
      el('button', {
        class: 'btn action pack',
        title: 'Pack = fold this hand',
        onclick: () => this.act(ACTION.PACK)
      }, [el('span', { text: 'Pack' }), el('span', { class: 'sub', text: 'fold' })]),
      el('button', {
        class: 'btn action',
        disabled: !options.check,
        title: options.check
          ? 'Nothing owed — pass for free'
          : 'Teen Patti has no free check: you must chaal (bet) or pack. Checking unlocks once you have matched every live player.',
        onclick: () => this.act(ACTION.CHECK)
      }, [el('span', { text: 'Check' }), el('span', { class: 'sub', text: options.check ? 'free' : 'n/a' })]),
      el('button', {
        class: 'btn action call',
        disabled: !options.call,
        title: options.call ? `${options.callLabel} — match the stake` : 'Not enough chips — go all-in',
        onclick: () => this.act(options.callLabel === 'Blind' ? ACTION.BLIND : ACTION.CHAAL)
      }, [
        el('span', { text: options.callLabel }),
        el('span', { class: 'sub', text: `${formatChips(options.callCost)}${you.seen ? '' : ' (blind)'}` })
      ]),
      el('button', {
        class: 'btn action allin',
        disabled: !options.allIn,
        title: 'Push your whole stack into the pot',
        onclick: () => this.act(ACTION.ALL_IN)
      }, [el('span', { text: 'All in' }), el('span', { class: 'sub', text: formatChips(options.allInAmount) })])
    ]);
    nodes.push(actionGroup);

    if (options.raise) {
      const min = options.minRaise;
      const max = options.maxRaise;
      if (!this.raiseValue || this.raiseValue < min || this.raiseValue > max) {
        this.raiseValue = Math.min(max, Math.max(min, snapshot.stake * 2 || min));
      }
      const slider = el('input', {
        type: 'range',
        min: String(min),
        max: String(max),
        step: '1',
        value: String(Math.min(Math.max(this.raiseValue, min), max)),
        oninput: (event) => {
          this.raiseValue = Number(event.target.value);
          valueLabel.textContent = formatChips(this.raiseValue);
          costLabel.textContent = `costs ${formatChips(raiseCostFor(this.raiseValue, you.seen))}`;
        }
      });
      const valueLabel = el('span', { class: 'value', text: formatChips(this.raiseValue) });
      const costLabel = el('span', { class: 'sub muted', text: `costs ${formatChips(raiseCostFor(this.raiseValue, you.seen))}` });
      const step = Math.max(1, snapshot.config.minRaise);
      nodes.push(el('div', { class: 'group raise-widget' }, [
        el('div', { class: 'steppers' }, [
          el('button', {
            class: 'btn small icon',
            text: '−',
            onclick: () => {
              this.raiseValue = Math.max(min, this.raiseValue - step);
              slider.value = String(this.raiseValue);
              valueLabel.textContent = formatChips(this.raiseValue);
              costLabel.textContent = `costs ${formatChips(raiseCostFor(this.raiseValue, you.seen))}`;
            }
          }),
          el('button', {
            class: 'btn small icon',
            text: '＋',
            onclick: () => {
              this.raiseValue = Math.min(max, this.raiseValue + step);
              slider.value = String(this.raiseValue);
              valueLabel.textContent = formatChips(this.raiseValue);
              costLabel.textContent = `costs ${formatChips(raiseCostFor(this.raiseValue, you.seen))}`;
            }
          })
        ]),
        el('div', {}, [
          el('div', { class: 'row', style: { gap: '8px', alignItems: 'baseline' } }, [
            el('span', { class: 'tiny muted', text: 'New stake' }),
            valueLabel
          ]),
          costLabel
        ]),
        slider
      ]));
      nodes.push(el('button', {
        class: 'btn action raise',
        onclick: () => this.act(ACTION.RAISE, { stake: this.raiseValue })
      }, [el('span', { text: 'Raise' }), el('span', { class: 'sub', text: `min ${formatChips(min)}` })]));
    }

    if (options.show) {
      nodes.push(el('button', {
        class: 'btn action show',
        title: 'Heads-up: pay the show cost and compare hands right now',
        onclick: () => this.act(ACTION.SHOW)
      }, [el('span', { text: 'Show' }), el('span', { class: 'sub', text: 'compare now' })]));
    }

    if (options.sideShow) {
      nodes.push(el('button', {
        class: 'btn action',
        title: 'Compare with the player on your right — the weaker hand packs',
        onclick: () => this.act(ACTION.SIDE_SHOW)
      }, [el('span', { text: '⚔ Side show' }), el('span', { class: 'sub', text: 'compare' })]));
    }

    bar.replaceChildren(...nodes);
  }

  renderHistory(snapshot) {
    const history = snapshot.history || [];
    if (!history.length) {
      this.els.historyBody.replaceChildren(el('p', { class: 'muted tiny', text: 'No hands finished yet.' }));
    } else {
      this.els.historyBody.replaceChildren(...history.map((hand) => el('div', { class: 'history-item' }, [
        el('div', { class: 'head' }, [
          el('b', { text: `Hand #${hand.handNo}` }),
          el('span', { class: 'pill gold', text: `pot ${formatChips(hand.pot)}` }),
          el('span', { class: 'pill', text: hand.reason }),
          el('span', { class: 'spacer' }),
          el('span', { class: 'tiny muted', text: relativeTime(hand.at) })
        ]),
        el('div', { class: 'tiny muted', text: `Won by ${hand.winners.map((winner) => `${winner.name} (${formatChips(winner.amount)})`).join(', ') || '—'}` }),
        el('div', { class: 'tiny muted', text: hand.players.map((player) => `${player.name}: ${player.packed ? 'packed' : player.hand || 'in hand'} · ${formatChips(player.committed)}`).join('  |  ') })
      ])));
    }
  }

  renderRankings() {
    const chart = [
      { name: 'Trail / Set', example: 'A♠ A♥ A♦', note: 'Three of the same rank — the nuts.' },
      { name: 'Pure Sequence', example: 'A♠ K♠ Q♠', note: 'Three consecutive cards, same suit. A-2-3 is the lowest.' },
      { name: 'Sequence', example: 'A♠ K♥ Q♦', note: 'Three consecutive cards, mixed suits.' },
      { name: 'Colour', example: 'A♠ J♠ 4♠', note: 'Three of one suit that do not run together.' },
      { name: 'Pair', example: 'K♠ K♥ 7♦', note: 'Two of a rank; kicker decides ties.' },
      { name: 'High Card', example: 'A♠ J♥ 9♦', note: 'Nothing matches — compare the top card.' }
    ];
    this.els.rankingsBody.replaceChildren(
      el('div', { class: 'rank-chart' }, chart.map((entry, index) => el('div', { class: 'rank-row' }, [
        el('span', { class: 'idx', text: String(index + 1) }),
        el('div', {}, [
          el('b', { text: entry.name }),
          el('div', { class: 'tiny muted', text: entry.note })
        ]),
        el('span', { class: 'cards-mini', text: entry.example })
      ]))),
      el('h4', { style: { marginTop: '6px' }, text: 'Table rules in play' }),
      el('ul', { class: 'rule-list' }, [
        el('li', { html: '<b>Boot</b> — everyone posts the ante to be dealt three cards.' }),
        el('li', { html: '<b>Blind vs Seen</b> — blind players bet half the stake; looking at your cards switches you to full chaal.' }),
        el('li', { html: '<b>Chaal</b> — match the current stake to stay in. A raise must beat the last stake.' }),
        el('li', { html: '<b>Side show</b> — with 3+ live players, compare with your right-hand neighbour; the weaker hand packs.' }),
        el('li', { html: '<b>Show</b> — heads-up, pay the show cost and compare immediately.' }),
        el('li', { html: '<b>Compulsory show</b> — after the configured number of rounds everybody still in reveals and the best hand wins.' })
      ]),
      el('p', { class: 'tiny muted', text: 'Note: Teen Patti is a three-card game, so there are no community cards — the pot and the showdown are the centre of the table.' })
    );
  }

  // ───────────────────────────────────────────────────────────── countdown ──

  startCountdown(snapshot) {
    this.stopCountdown();
    if (snapshot.phase !== PHASE.BETTING || !snapshot.turnDeadline) return;
    const tick = () => {
      const turnSeat = this.snapshot?.seats?.find((seat) => seat?.isTurn);
      if (!turnSeat) return;
      const node = this.seats.get(turnSeat.id);
      if (!node?.refs.ring) return;
      const total = Math.max(1, this.snapshot.turnSeconds * 1000);
      const remaining = Math.max(0, this.snapshot.turnDeadline - Date.now());
      const fraction = remaining / total;
      const circumference = 2 * Math.PI * 22;
      const bar = node.refs.ring.querySelector('.bar');
      if (bar) {
        bar.setAttribute('stroke-dashoffset', `${circumference * (1 - fraction)}`);
        bar.style.stroke = fraction < 0.25 ? 'var(--red)' : 'var(--gold)';
      }
      const isMe = this.snapshot.you?.isTurn;
      const waiting = this.els.actionBar.querySelector('.turn-banner span:last-child');
      if (waiting && isMe === false) {
        waiting.textContent = `${turnSeat.isBot ? '🤖 ' : ''}${turnSeat.name} is thinking… ${Math.ceil(remaining / 1000)}s`;
      }
      if (isMe) {
        const heading = this.els.actionBar.querySelector('.turn-banner');
        if (heading) heading.textContent = '';
      }
      if (remaining <= 0) this.stopCountdown();
    };
    tick();
    this.countdownTimer = setInterval(tick, 250);
  }

  stopCountdown() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  }

  // ─────────────────────────────────────────────────────────────── events ──

  handleEvents(events, snapshot) {
    for (const event of events) {
      switch (event.type) {
        case 'hand:start': {
          this.sound.shuffle();
          this.lastWinner = null;
          this.els.winnerHost.replaceChildren();
          this.els.dealArea.replaceChildren(el('span', { class: 'pill', text: `Hand #${event.handNo} dealt — boot ${formatChips(snapshot?.config?.boot ?? 0)}` }));
          const seats = this.snapshot?.seats || [];
          seats.forEach((seat, index) => {
            if (seat?.inHand) this.sound.deal(index % 4);
          });
          break;
        }
        case 'deal':
          break;
        case 'action':
          this.onActionEvent(event);
          break;
        case 'allin':
          this.sound.chipStack(3);
          break;
        case 'round':
          toast(`Betting round ${event.round} — stake ${formatChips(event.stake)}`, { timeout: 1800 });
          break;
        case 'sideshow:request':
          this.showSideShowPrompt(event);
          break;
        case 'sideshow:result':
          this.onSideShowResult(event);
          break;
        case 'sideshow:declined':
          toast('Side show declined');
          break;
        case 'showdown':
          this.onShowdown(event);
          break;
        case 'hand:end':
          this.onHandEnd(event);
          break;
        case 'player:join':
          if (event.isBot) toast(`${event.name} sat down`, { timeout: 1800 });
          break;
        default:
          break;
      }
    }
  }

  onActionEvent(event) {
    const node = this.seats.get(event.playerId);
    if (!node) return;
    switch (event.action) {
      case 'pack':
        this.sound.fold();
        break;
      case 'allin':
        this.sound.chipStack(4);
        this.flyChips(node.el, Math.min(6, 2 + Math.floor((event.amount || 0) / 50)));
        break;
      case 'raise':
        this.sound.chip();
        this.flyChips(node.el, 3);
        break;
      case 'chaal':
      case 'blind':
        this.sound.chip();
        this.flyChips(node.el, 1);
        break;
      case 'see':
        this.sound.flip();
        break;
      default:
        break;
    }
    if (event.timeout) toast(`${this.nameOf(event.playerId)} ran out of time and packed`, { kind: 'warn', timeout: 2200 });
  }

  nameOf(playerId) {
    return this.snapshot?.seats?.find((seat) => seat?.id === playerId)?.name || 'A player';
  }

  showSideShowPrompt(event) {
    const snapshot = this.snapshot;
    const me = snapshot?.you;
    const requester = this.nameOf(event.requesterId);
    if (me?.id && event.targetId === me.id) {
      this.sound.show();
      toast(`${requester} wants a side show — respond in the action bar`, { kind: 'warn', timeout: 4000 });
    } else if (me?.id === event.requesterId) {
      toast('Side show requested…', { timeout: 1500 });
    } else if (me?.id) {
      toast(`${requester} asked ${this.nameOf(event.targetId)} for a side show`, { timeout: 2200 });
    }
  }

  onSideShowResult(event) {
    this.sound.show();
    const winner = this.nameOf(event.winnerId);
    const loser = this.nameOf(event.loserId);
    const cards = (list) => cardRow(list, { size: 'sm' });
    openModal({
      title: 'Side show',
      icon: '⚔️',
      body: [
        el('p', { class: 'muted', text: `${winner} had the stronger hand — ${loser} packs.` })
      ],
      actions: [{ label: 'Continue', kind: 'primary' }]
    });
  }

  onShowdown(event) {
    const snapshot = this.snapshot;
    const myWinner = event.winners.find((winner) => winner.id === snapshot?.you?.id);
    if (myWinner) {
      this.sound.win();
      this.sparkle();
    } else {
      this.sound.lose();
    }
    const winner = event.winners[0];
    if (winner) {
      this.lastWinner = winner;
      const banner = el('div', { class: 'winner-banner' }, [
        el('div', { class: 'big', text: `${winner.avatar || ''} ${winner.name} wins ${formatChips(winner.amount)}` }),
        el('div', { class: 'sub', text: event.reason === 'fold' ? 'everyone else packed' : `pot ${formatChips(event.pot)}` })
      ]);
      this.els.winnerHost.replaceChildren(banner);
      setTimeout(() => {
        if (this.els.winnerHost.contains(banner)) banner.remove();
      }, 4200);
    }
    this.showShowdownCards();
  }

  /** At showdown the centre of the felt shows the best hand face up. */
  showShowdownCards() {
    const snapshot = this.snapshot;
    if (!snapshot?.results) return;
    const best = snapshot.results.rankings[0];
    if (!best) return;
    const cards = snapshot.results.reveal.find((entry) => entry.id === best.id)?.cards || [];
    this.els.dealArea.replaceChildren(el('div', { class: 'card-panel', style: { padding: '10px 14px', textAlign: 'center' } }, [
      el('div', { class: 'tiny muted', text: best.name }),
      el('div', { class: 'row', style: { gap: '6px', justifyContent: 'center', margin: '6px 0' } }, cards.map((card) => cardEl(card, { size: 'md' }))),
      el('div', { style: { fontWeight: '700', color: 'var(--gold)' }, text: `${best.hand.text} · ${formatChips(best.committed)} in` })
    ]));
  }

  onHandEnd(event) {
    const snapshot = this.snapshot;
    const myWinner = event.winners.find((winner) => winner.id === snapshot?.you?.id);
    this.callbacks.onHandResult?.({
      won: Boolean(myWinner),
      amount: myWinner ? myWinner.amount : 0,
      results: snapshot?.results
    });
  }

  flyChips(fromEl, count = 1) {
    const to = this.els.potDisplay.getBoundingClientRect();
    const from = fromEl.getBoundingClientRect();
    for (let i = 0; i < count; i += 1) {
      const chip = el('div', { class: `chip c${[5, 10, 50, 100, 500][Math.floor(Math.random() * 5)]} fly-chip` });
      chip.style.left = `${from.left + from.width / 2}px`;
      chip.style.top = `${from.top + from.height / 2}px`;
      chip.style.transitionDelay = `${i * 55}ms`;
      document.body.append(chip);
      requestAnimationFrame(() => {
        chip.style.transform = `translate(${to.left + to.width / 2 - from.left - from.width / 2}px, ${to.top + to.height / 2 - from.top - from.height / 2}px) scale(0.7)`;
        chip.style.opacity = '0.9';
      });
      setTimeout(() => chip.remove(), 800 + i * 60);
    }
  }

  sparkle() {
    const rect = this.els.potDisplay.getBoundingClientRect();
    for (let i = 0; i < 14; i += 1) {
      const node = el('div', { class: 'sparkle', text: ['✨', '⭐', '🎉', '💫'][i % 4] });
      node.style.left = `${rect.left + rect.width / 2 + (Math.random() * 220 - 110)}px`;
      node.style.top = `${rect.top + rect.height / 2 + (Math.random() * 40 - 20)}px`;
      node.style.setProperty('--sx', `${Math.random() * 80 - 40}px`);
      node.style.animationDelay = `${i * 45}ms`;
      document.body.append(node);
      setTimeout(() => node.remove(), 1600 + i * 50);
    }
  }

  // ────────────────────────────────────────────────────────────────── chat ──

  renderChat() {
    const empty = el('p', { class: 'muted tiny', text: 'Chat with the table — reactions float over your seat.' });
    this.els.chatBody.replaceChildren(...(this.chatLog.length
      ? this.chatLog.map((message) => el('div', { class: `chat-line ${message.system ? 'system' : ''} ${message.bot ? 'bot' : ''}` }, [
          message.system ? null : el('span', { class: 'who', text: `${message.avatar || ''} ${message.from}` }),
          el('span', { text: message.text })
        ]))
      : [empty]));
    this.els.chatBody.scrollTop = this.els.chatBody.scrollHeight;
  }

  pushChat(message) {
    const emote = message.emote || isEmojiOnly(message.text);
    this.chatLog.push({ ...message, emote, at: Date.now() });
    if (this.chatLog.length > 120) this.chatLog.shift();
    this.renderChat();
    if (!message.system) {
      this.sound.message();
      if (emote) this.floatEmote(message.text, message.from);
    }
  }

  sendChat() {
    const text = this.els.chatInput.value.trim();
    if (!text) return;
    this.els.chatInput.value = '';
    if (this.controller?.isOnline) this.callbacks.onChat?.(text);
    else this.callbacks.onChat?.(text);
  }

  sendReaction(emoji) {
    this.callbacks.onReaction?.(emoji);
  }

  floatEmote(text, from) {
    const seat = [...this.seats.values()].find((node) => node.refs.name?.textContent === from);
    const rect = seat?.el.getBoundingClientRect() || this.els.tableArea?.getBoundingClientRect() || { left: 200, top: 200, width: 0, height: 0 };
    const node = el('div', { class: 'reaction-float', text, style: { left: `${rect.left + rect.width / 2}px`, top: `${rect.top}px` } });
    document.body.append(node);
    setTimeout(() => node.remove(), 1600);
  }

  // ─────────────────────────────────────────────────────────────── plumbing ──

  act(action, payload = {}) {
    this.sound.click();
    return this.controller?.dispatch(action, payload);
  }

  toggleDrawer(id) {
    const drawer = document.getElementById(id);
    const isOpen = drawer.classList.contains('open');
    this.closeDrawers();
    if (!isOpen) drawer.classList.add('open');
  }

  closeDrawers() {
    $$('.drawer').forEach((drawer) => drawer.classList.remove('open'));
  }

  destroy() {
    this.stopCountdown();
    this.seats.clear();
    this.els?.seats?.replaceChildren();
    this.els?.winnerHost?.replaceChildren();
    this.closeDrawers();
  }
}

export default GameView;
