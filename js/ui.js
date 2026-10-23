/*
 * Screen code for Shoe & Odds. The rules and the math live in engine.js (window.BJ).
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STORE = 'shoe-odds-v1';
  const ACTIONS = ['H', 'S', 'D', 'P', 'R'];
  const ACTION_KEYS = { h: 'H', s: 'S', d: 'D', p: 'P', r: 'R' };
  const AVAIL_KEY = { H: 'hit', S: 'stand', D: 'double', P: 'split', R: 'surrender' };
  const CHIPS = [5, 25, 100, 500];
  const UP_NAMES = { 1: 'A', 10: '10' };

  const DEFAULT_SETTINGS = {
    rules: Object.assign({}, BJ.DEFAULT_RULES),
    bots: ['basic', 'mimic', 'counter'],
    seatPos: 1,
    startBankroll: 1000,
    botBet: 25,
    speed: 650,
    showOdds: true,
    coach: 'hint',
    showCount: true,
    minBet: 5,
    maxBet: 1000,
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; }
  }
  const saved = load();
  const S = Object.assign({}, DEFAULT_SETTINGS, saved.settings || {});
  S.rules = Object.assign({}, BJ.DEFAULT_RULES, (saved.settings && saved.settings.rules) || {});

  const human = BJ.makeSeat({ name: 'You', type: 'human', bankroll: saved.human ? saved.human.bankroll : S.startBankroll });
  if (saved.human && saved.human.stats) {
    human.stats = Object.assign(BJ.newStats(), saved.human.stats);
    if (human.stats.lowBankroll === null) human.stats.lowBankroll = human.bankroll;
  }
  let rebuys = (saved.human && saved.human.rebuys) || 0;
  let history = saved.history || [];
  let simResults = saved.simResults || [];
  let lastBet = saved.lastBet || 25;
  human.pendingBet = Math.min(lastBet, human.bankroll);
  let sessionStart = human.bankroll;

  let table = null;
  let busy = false;
  let coachFeedback = null;
  let countCheck = null;
  let roundSummary = null;
  let coachShort = null;
  let logLines = [];
  let oddsCache = { key: null, odds: null };
  let shownCards = new WeakMap();
  let view = 'table';

  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        settings: S,
        human: { bankroll: human.bankroll, stats: human.stats, rebuys },
        history: history.slice(-1000),
        simResults: simResults.slice(0, 30),
        lastBet,
      }));
    } catch (e) { /* storage blocked: the game still works for this visit */ }
  }

  function buildTable() {
    table = new BJ.Table(S.rules);
    const seats = S.bots.slice(0, 6).map((style, i) =>
      BJ.makeSeat({ name: BJ.BOT_NAMES[i], type: 'bot', style, bankroll: 1000, baseBet: S.botBet }));
    seats.splice(Math.min(S.seatPos, seats.length), 0, human);
    table.seats = seats;
    human.hands = [];
    human.inRound = false;
    coachFeedback = null;
    countCheck = null;
    logLines = [];
    addLog('shuffle', 'New table: ' + S.rules.decks + ' decks shuffled. ' + (seats.length - 1) + ' computer player' + (seats.length === 2 ? '' : 's') + ' sit down.');
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  const money = (n) => {
    const a = Math.abs(n);
    const d = Number.isInteger(Math.round(a * 100) / 100) ? 0 : 2;
    return (n < 0 ? '-$' : '$') + a.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  const signedMoney = (n) => (n > 0 ? '+' : '') + money(n);
  const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
  const signedPct = (x, d = 1) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x * 100).toFixed(d) + '%';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const upName = (v) => UP_NAMES[v] || String(v);
  const payoutName = (p) => (Math.abs(p - 1.5) < 1e-9 ? '3 to 2' : Math.abs(p - 1.2) < 1e-9 ? '6 to 5' : '1 to 1');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function seatPosName(i, n) {
    if (n === 1) return 'only seat';
    if (i === 0) return 'first base';
    if (i === n - 1) return 'third base';
    return 'seat ' + (i + 1);
  }

  // ---------------------------------------------------------------------------
  // Table rendering
  // ---------------------------------------------------------------------------

  // A card slides in the first time it is drawn. The hole card flips in place.
  function cardHTML(c, hidden) {
    const anim = shownCards.has(c) ? '' : ' deal-in';
    shownCards.set(c, true);
    if (hidden) return '<div class="card back' + anim + '" role="img" aria-label="Face-down card"></div>';
    const red = c.suit === '♥' || c.suit === '♦';
    return '<div class="card' + (red ? ' red' : '') + anim + '" role="img" aria-label="' + c.rank + c.suit + '">' +
      '<span class="corner">' + c.rank + '<small>' + c.suit + '</small></span><span class="pip">' + c.suit + '</span></div>';
  }
  function renderFelt() {
    const t = table;
    const r = S.rules;
    // Dealer
    const d = t.dealer;
    $('dealer-cards').innerHTML = d.cards.map((c, i) => cardHTML(c, i === 1 && d.holeHidden)).join('');
    let dt = '';
    if (d.cards.length) {
      if (d.holeHidden) dt = '<span class="tot">shows ' + upName(d.cards[0].value) + '</span>';
      else dt = '<span class="tot">' + esc(BJ.describeHand(d.cards)) + '</span>';
    }
    $('dealer-total').innerHTML = dt;

    // Shoe and discard tray
    const shoe = t.shoe;
    const left = shoe.remaining;
    $('shoe').innerHTML = 'Shoe<div class="shoe-box" title="Cards left in the shoe. The yellow mark is the cut card.">' +
      '<div class="shoe-fill" style="width:' + (left / shoe.total * 100).toFixed(1) + '%"></div>' +
      '<div class="shoe-cut" style="left:' + ((1 - r.penetration) * 100).toFixed(1) + '%"></div></div>' +
      '<div class="shoe-label">' + left + ' cards · ' + shoe.decksRemaining.toFixed(1) + ' decks</div>';
    $('tray').innerHTML = 'Discards<div class="shoe-label">' + shoe.discards + ' cards</div>' +
      (shoe.cutCardOut ? '<div class="shoe-label" style="color:#ffd23f">Cut card is out: shuffle next hand</div>' : '');

    $('felt-print').innerHTML = '<div class="big">Blackjack pays ' + payoutName(r.blackjackPays) + '</div>' +
      '<div class="small">Dealer must ' + (r.hitSoft17 ? 'hit' : 'stand on') + ' soft 17 · Insurance pays 2 to 1 · ' + r.decks + ' deck' + (r.decks > 1 ? 's' : '') + ' · $' + S.minBet + ' to $' + S.maxBet.toLocaleString() + '</div>';

    // Seats
    const cur = t.current();
    const n = t.seats.length;
    $('seats').innerHTML = t.seats.map((seat, i) => {
      const you = seat === human;
      const isTurn = cur && cur.seat === seat;
      const cls = 'seat' + (you ? ' you' : '') + (isTurn ? ' turn' : '') + (!seat.inRound && t.phase !== 'betting' && t.phase !== 'roundOver' ? ' out' : '');
      let hands = '';
      if (seat.hands.length) {
        hands = seat.hands.map((h, hi) => {
          const active = isTurn && cur.handIndex === hi && seat.hands.length > 1;
          let res = '';
          if (h.result) {
            const label = { win: 'Win', blackjack: 'Blackjack', lose: 'Lose', bust: 'Bust', push: 'Push', surrender: 'Surrender' }[h.result];
            res = ' <span class="result ' + h.result + '">' + label + (h.net ? ' ' + signedMoney(h.net) : '') + '</span>';
          }
          return '<div class="hand' + (active ? ' active' : '') + '"><div class="cards">' + h.cards.map((c) => cardHTML(c, false)).join('') + '</div>' +
            '<div><span class="tot">' + esc(BJ.describeHand(h.cards)) + '</span> <span class="bet-chip">$' + h.bet + '</span>' + res + '</div></div>';
        }).join('');
      } else if (you && human.pendingBet > 0) {
        hands = '<div class="hand"><span class="bet-chip">$' + human.pendingBet + '</span></div>';
      }
      const ins = seat.insurance ? ' · insured $' + seat.insurance : '';
      const style = you ? 'You' : BJ.BOT_STYLES[seat.style].label;
      return '<div class="' + cls + '"><div class="seat-name">' + esc(seat.name) + '</div>' +
        '<div class="seat-style">' + esc(style) + ' · ' + seatPosName(i, n) + '</div>' +
        '<div class="hands">' + hands + '</div>' +
        '<div class="seat-bank">' + money(seat.bankroll) + ins + '</div></div>';
    }).join('');

    // Phone view: the other players as a thin strip with their totals.
    $('others').innerHTML = t.seats.filter((s) => s !== human).map((seat) => {
      const isTurn = cur && cur.seat === seat;
      let info = '<span class="num">—</span>';
      if (seat.hands.length) {
        info = seat.hands.map((h) => {
          const res = h.result ? ' <span class="result ' + h.result + '">' + { win: 'Win', blackjack: 'BJ', lose: 'Lose', bust: 'Bust', push: 'Push', surrender: 'Surr' }[h.result] + '</span>' : '';
          return '<span class="num">' + esc(BJ.describeHand(h.cards).replace('bust with ', 'bust ')) + '</span>' + res;
        }).join(' ');
      }
      return '<div class="other' + (isTurn ? ' turn' : '') + '"><b>' + esc(seat.name) + '</b>' + info + '</div>';
    }).join('');
  }

  function renderHeader() {
    $('bankroll').textContent = money(human.bankroll);
    const net = human.bankroll - sessionStart;
    const el = $('session-net');
    el.textContent = signedMoney(net);
    el.className = net > 0 ? 'pos' : net < 0 ? 'neg' : '';
  }

  function isHumanTurn() {
    const cur = table.current();
    return !!cur && cur.seat === human;
  }

  function renderControls() {
    const t = table;
    const c = $('controls');
    const phase = t.phase;
    if (phase === 'insurance' && human.inRound && !human.insuranceDecided) {
      const amount = human.hands[0].bet / 2;
      const bj = BJ.isNatural(human.hands[0].cards);
      const canPay = human.bankroll >= amount;
      c.innerHTML = '<div class="prompt">' + (bj
        ? 'You have blackjack and the dealer shows an Ace. Take even money (a sure 1 to 1 win)?'
        : 'The dealer shows an Ace. Insurance costs $' + amount + ' and pays 2 to 1 if the dealer has blackjack.') + '</div>' +
        '<div class="row"><button class="btn" id="ins-yes"' + (canPay ? '' : ' disabled') + '>' + (bj ? 'Take even money' : 'Take insurance') + ' <kbd>I</kbd></button>' +
        '<button class="btn" id="ins-no">' + (bj ? 'No, play it out' : 'No insurance') + ' <kbd>N</kbd></button></div>';
      $('ins-yes').onclick = () => humanInsurance(true);
      $('ins-no').onclick = () => humanInsurance(false);
      return;
    }
    if (phase === 'playing' && isHumanTurn() && !busy) {
      const cur = t.current();
      const av = t.available();
      const rec = S.coach === 'hint' ? t.recommend() : null;
      const handLabel = (cur.seat.hands.length > 1 ? 'Hand ' + (cur.handIndex + 1) + ': ' : 'Your hand: ') + BJ.describeHand(cur.hand.cards);
      c.innerHTML = '<div class="prompt play">' + esc(handLabel) + ' against the dealer\'s ' + upName(t.upCard.value) + '</div><div class="row actions">' +
        ACTIONS.map((a) => '<button class="btn' + (rec === a ? ' rec' : '') + '" data-act="' + a + '"' + (av[AVAIL_KEY[a]] ? '' : ' disabled') + '>' +
          BJ.ACTION_NAMES[a] + ' <kbd>' + (a === 'P' ? 'P' : a) + '</kbd></button>').join('') + '</div>' +
        (rec ? '<div class="hint">The ring marks the basic strategy move. Turn hints off in Settings to test yourself.</div>' : '');
      c.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => humanAct(b.dataset.act); });
      return;
    }
    if (phase === 'betting' || phase === 'roundOver') {
      if (human.bankroll < S.minBet) {
        c.innerHTML = '<div class="prompt">You are out of chips.</div><div class="row"><button class="btn primary" id="rebuy">Buy in again for ' + money(S.startBankroll) + '</button></div>' +
          '<div class="hint">A real bankroll does not refill. The Stats tab shows how fast the house edge and bad luck can empty one.</div>';
        $('rebuy').onclick = rebuy;
        return;
      }
      const bet = human.pendingBet;
      const valid = bet >= S.minBet && bet <= Math.min(S.maxBet, human.bankroll);
      let summary = '';
      if (phase === 'roundOver' && roundSummary !== null) {
        const r = roundSummary;
        summary = '<div class="prompt">' + (r > 0 ? 'You won ' + money(r) + ' this hand.' : r < 0 ? 'You lost ' + money(-r) + ' this hand.' : 'You broke even this hand.') + '</div>';
      }
      let countTip = '';
      if (S.showCount) {
        const units = BJ.counterUnits(t.shoe.trueCount);
        countTip = '<div class="hint">Counting tip: at true count ' + t.shoe.trueCount.toFixed(1) + ', a Hi-Lo counter bets ' + units + ' unit' + (units > 1 ? 's' : '') + '.</div>';
      }
      c.innerHTML = summary + '<div class="row">' +
        CHIPS.map((v) => '<button class="chip c' + v + '" data-chip="' + v + '"' + (bet + v > Math.min(S.maxBet, human.bankroll) ? ' disabled' : '') + ' aria-label="Add $' + v + '">' + v + '</button>').join('') +
        '<div class="bet-display">Bet <b>' + money(bet) + '</b></div>' +
        '<button class="btn" id="clear-bet"' + (bet ? '' : ' disabled') + '>Clear</button>' +
        '<button class="btn primary" id="deal"' + (valid ? '' : ' disabled') + '>Deal <kbd>Enter</kbd></button></div>' +
        (valid ? '' : '<div class="hint">Place a bet from ' + money(S.minBet) + ' to ' + money(Math.min(S.maxBet, human.bankroll)) + '.</div>') + countTip;
      c.querySelectorAll('[data-chip]').forEach((b) => {
        b.onclick = () => { human.pendingBet += Number(b.dataset.chip); renderAll(); };
      });
      $('clear-bet').onclick = () => { human.pendingBet = 0; renderAll(); };
      $('deal').onclick = deal;
      return;
    }
    const cur = t.current();
    const who = phase === 'dealer' ? 'The dealer plays' : cur ? cur.seat.name + ' is playing' : 'Dealing';
    c.innerHTML = '<div class="prompt">' + esc(who) + '…</div><div class="hint">Watch the cards. Each card that you see changes the count and the odds.</div>';
  }

  function currentOdds() {
    const cur = table.current();
    if (!cur) return null;
    const key = table.roundNo + ':' + cur.seatIndex + ':' + cur.handIndex + ':' + cur.hand.cards.length + ':' + table.shoe.pos;
    if (oddsCache.key !== key) oddsCache = { key, odds: table.odds() };
    return oddsCache.odds;
  }

  function evRow(label, ev, best) {
    const w = Math.min(Math.abs(ev), 1) * 50;
    const cls = ev >= 0 ? 'pos' : 'neg';
    return '<div class="ev-row' + (best ? ' best' : '') + '"><span>' + label + '</span><div class="ev-track"><div class="ev-bar ' + cls + '" style="width:' + w.toFixed(1) + '%"></div></div>' +
      '<span class="ev-val ' + cls + '">' + signedPct(ev) + '</span></div>';
  }

  function renderOdds() {
    const p = $('odds-panel');
    const t = table;
    const edge = BJ.houseEdgeEstimate(S.rules).total;
    if (!S.showOdds) {
      p.innerHTML = '<h2>Live odds</h2><p class="note">The odds panel is off. Turn it on in Settings.</p>';
      return;
    }
    if (t.phase === 'insurance' && human.inRound && !human.insuranceDecided) {
      const comp = t.unseenComposition();
      let n = 0;
      for (let r = 1; r <= 10; r++) n += comp[r];
      const pTen = comp[10] / n;
      p.innerHTML = '<h2>Insurance odds</h2>' +
        '<p>Insurance wins only if the hole card is a ten-value card. It pays 2 to 1, so it breaks even at 1 in 3 (33.3%).</p>' +
        '<dl class="facts"><dt>Unseen ten-value cards</dt><dd>' + comp[10] + ' of ' + n + '</dd>' +
        '<dt>Chance the hole card is a ten</dt><dd>' + pct(pTen) + '</dd>' +
        '<dt>Average result per $1 of insurance</dt><dd class="' + (pTen > 1 / 3 ? 'pos' : 'neg') + '">' + signedPct(3 * pTen - 1) + '</dd></dl>';
      return;
    }
    if (t.phase === 'playing' && isHumanTurn()) {
      const o = currentOdds();
      const cur = t.current();
      const rows = [];
      const list = [['H', 'Hit', o.hit], ['S', 'Stand', o.stand], ['D', 'Double', o.double], ['P', 'Split', o.split], ['R', 'Surrender', o.surrender]].filter((x) => x[2]);
      const bestEv = Math.max.apply(null, list.map((x) => x[2].ev));
      for (const [, label, v] of list) rows.push(evRow(label, v.ev, v.ev === bestEv));
      const bet = cur.hand.bet;
      const dl = o.dealer;
      p.innerHTML = '<h2>Live odds for this hand</h2>' +
        '<div class="ev-list">' + rows.join('') + '</div>' +
        '<dl class="facts">' +
        '<dt>Chance a hit busts you</dt><dd>' + pct(o.hit.bust) + '</dd>' +
        '<dt>If you stand: win / push / lose</dt><dd>' + pct(o.stand.win, 0) + ' / ' + pct(o.stand.push, 0) + ' / ' + pct(o.stand.lose, 0) + '</dd>' +
        '<dt>Dealer busts from ' + upName(t.upCard.value) + '</dt><dd>' + pct(dl[5]) + '</dd>' +
        '<dt>Best move is worth</dt><dd class="' + (bestEv >= 0 ? 'pos' : 'neg') + '">' + signedMoney(Math.round(bestEv * bet * 100) / 100) + ' avg</dd>' +
        '</dl><p class="note" style="margin-top:8px">Bars show the expected value (EV): your average win or loss per $1 bet if you could replay this exact spot many times. The math uses the real cards left in this shoe.</p>';
      return;
    }
    if (t.dealer.cards.length && t.phase !== 'betting') {
      const up = t.upCard.value;
      const comp = BJ.freshComposition(S.rules.decks);
      comp[up]--;
      const dist = BJ.dealerOutcomes(up, comp, S.rules, up === 1 || up === 10);
      p.innerHTML = '<h2>Dealer\'s up card: ' + upName(up) + '</h2>' +
        '<p>From this card the dealer busts about <b>' + pct(dist[5]) + '</b> of the time. ' +
        (up >= 2 && up <= 6 ? 'This is a weak card for the dealer. Players stand on more hands and double more often.' : 'This is a strong card for the dealer. Players must take more risk to beat it.') + '</p>' +
        '<dl class="facts">' + ['17', '18', '19', '20', '21', 'Bust'].map((l, i) => '<dt>Dealer ends on ' + l + '</dt><dd>' + pct(dist[i]) + '</dd>').join('') + '</dl>';
      return;
    }
    p.innerHTML = '<h2>The odds at this table</h2>' +
      '<p>With these rules the house edge is about <b>' + edge.toFixed(2) + '%</b> if you play perfect basic strategy. That means you lose about ' + money(edge / 100 * (human.pendingBet || 25)) + ' on average for each ' + money(human.pendingBet || 25) + ' hand.</p>' +
      '<p class="note">Most hands you will lose (about 48%) or push (about 8%). You win about 44% of hands. Blackjack payouts, doubles and splits make up most of the difference.</p>';
  }

  function renderCoach() {
    const p = $('coach-panel');
    if (S.coach === 'off') {
      p.innerHTML = '<h2>Strategy coach</h2><p class="note">The coach is off. Turn it on in Settings.</p>';
      return;
    }
    let html = '<h2>Strategy coach</h2>';
    if (coachFeedback) html += coachFeedback;
    if (S.coach === 'hint' && table.phase === 'playing' && isHumanTurn()) {
      const cur = table.current();
      const rec = table.recommend();
      html += '<div class="coach-msg"><strong>Basic strategy: ' + BJ.ACTION_NAMES[rec] + '</strong>' +
        esc(BJ.strategyReason(cur.hand.cards, table.upCard.value, rec)) + '</div>';
    } else if (!coachFeedback) {
      const st = human.stats;
      html += st.decisions
        ? '<p>You made the basic strategy move on <b>' + st.correct + ' of ' + st.decisions + '</b> decisions (' + pct(st.correct / st.decisions, 0) + ').</p>'
        : '<p>Play a hand. The coach checks each move against basic strategy, the move with the best long-run result.</p>';
    }
    p.innerHTML = html;
  }

  function feedbackHTML(fb, odds) {
    const evs = { H: odds.hit.ev, S: odds.stand.ev, D: odds.double && odds.double.ev, P: odds.split && odds.split.ev, R: odds.surrender && odds.surrender.ev };
    const recName = BJ.ACTION_NAMES[fb.recommended];
    const reason = esc(BJ.strategyReason(fb.cards, fb.up, fb.recommended));
    if (fb.correct) {
      return '<div class="coach-msg ok"><span class="coach-tag ok">Correct</span><strong>' + recName + ' on ' + esc(fb.handText) + ' against ' + upName(fb.up) + '.</strong>' + reason + '</div>';
    }
    const cost = (evs[fb.recommended] || 0) - (evs[fb.action] || 0);
    const costText = cost > 0.0005
      ? ' Your move costs about <b>' + pct(cost) + '</b> of your bet on average.'
      : ' With the exact cards left in this shoe, your move was about as good or better. Card counters use small changes like this.';
    return '<div class="coach-msg bad"><span class="coach-tag bad">Not basic strategy</span><strong>You chose ' + BJ.ACTION_NAMES[fb.action] + '. Basic strategy says ' + recName + '.</strong>' + reason + costText + '</div>';
  }

  function renderCount() {
    const p = $('count-panel');
    const shoe = table.shoe;
    const tc = shoe.trueCount;
    const edge = BJ.playerEdgeFromCount(tc, S.rules);
    let html = '<h2>Card counting trainer (Hi-Lo)</h2>';
    if (S.showCount) {
      html += '<div class="count-grid"><div><b>' + (shoe.runningCount > 0 ? '+' : '') + shoe.runningCount + '</b><span>Running count</span></div>' +
        '<div><b>' + (tc > 0 ? '+' : '') + tc.toFixed(1) + '</b><span>True count</span></div>' +
        '<div><b class="' + (edge >= 0 ? 'pos' : 'neg') + '">' + signedPct(edge / 100, 1) + '</b><span>Your edge</span></div></div>' +
        '<p class="note" style="margin-top:8px">2–6 count +1. 7–9 count 0. 10s and Aces count −1. True count = running count ÷ decks left. Each +1 true count gives you about 0.5% more edge.</p>';
    } else {
      html += '<p>The count is hidden. Count each card you see, then check your running count.</p>' +
        '<div class="count-quiz"><input id="count-guess" type="number" inputmode="numeric" aria-label="Your running count" placeholder="e.g. -3">' +
        '<button class="btn" id="count-check">Check</button></div>' +
        (countCheck ? '<p class="' + (countCheck.ok ? 'pos' : 'neg') + '" style="margin-top:8px">' + countCheck.text + '</p>' : '') +
        '<p class="note" style="margin-top:8px">2–6 count +1. 7–9 count 0. 10s and Aces count −1. The face-down hole card counts only when the dealer turns it over.</p>';
    }
    p.innerHTML = html;
    if (!S.showCount) {
      $('count-check').onclick = () => {
        const g = Number($('count-guess').value);
        const rc = shoe.runningCount;
        countCheck = g === rc
          ? { ok: true, text: 'Correct. The running count is ' + rc + '.' }
          : { ok: false, text: 'Not quite. The running count is ' + rc + ', not ' + g + '.' };
        renderCount();
      };
    }
  }

  function shortFeedback(fb, odds) {
    if (fb.correct) return '<span class="ok">✓ ' + BJ.ACTION_NAMES[fb.action] + ' was correct.</span>';
    const evs = { H: odds.hit.ev, S: odds.stand.ev, D: odds.double && odds.double.ev, P: odds.split && odds.split.ev, R: odds.surrender && odds.surrender.ev };
    const cost = (evs[fb.recommended] || 0) - (evs[fb.action] || 0);
    return '<span class="bad">✗ Basic strategy: ' + BJ.ACTION_NAMES[fb.recommended] + (cost > 0.0005 ? ' (cost ' + pct(cost) + ')' : '') + '.</span>';
  }

  // Phone view: one or two lines of the most useful facts. Tap to open the full panel.
  function renderStrip() {
    const t = table;
    const parts = [];
    const tc = t.shoe.trueCount;
    const countPart = S.showCount ? 'True count ' + (tc > 0 ? '+' : '') + tc.toFixed(1) : '';
    if (t.phase === 'insurance' && human.inRound && !human.insuranceDecided) {
      const comp = t.unseenComposition();
      let n = 0;
      for (let r = 1; r <= 10; r++) n += comp[r];
      const pTen = comp[10] / n;
      if (S.showOdds) parts.push('Dealer blackjack chance ' + pct(pTen) + ' · Insurance EV ' + signedPct(3 * pTen - 1));
      parts.push(countPart);
    } else if (t.phase === 'playing' && isHumanTurn()) {
      if (coachShort) parts.push(coachShort);
      if (S.coach === 'hint') parts.push('Coach: <b>' + BJ.ACTION_NAMES[t.recommend()] + '</b>');
      if (S.showOdds) {
        const o = currentOdds();
        const list = [['Hit', o.hit], ['Stand', o.stand], ['Double', o.double], ['Split', o.split], ['Surrender', o.surrender]].filter((x) => x[1]);
        const best = list.reduce((a, b) => (b[1].ev > a[1].ev ? b : a));
        parts.push('Best EV: ' + best[0] + ' ' + signedPct(best[1].ev) + ' · Bust if hit ' + pct(o.hit.bust, 0));
      }
      parts.push(countPart);
    } else if (t.phase === 'betting' || t.phase === 'roundOver') {
      if (coachShort) parts.push(coachShort);
      parts.push('House edge ' + BJ.houseEdgeEstimate(S.rules).total.toFixed(2) + '%');
      if (S.showCount) {
        const u = BJ.counterUnits(tc);
        parts.push(countPart + ' · Counter bets ' + u + ' unit' + (u > 1 ? 's' : ''));
      }
    } else {
      if (coachShort) parts.push(coachShort);
      if (t.dealer.cards.length && S.showOdds) {
        const up = t.upCard.value;
        const comp = BJ.freshComposition(S.rules.decks);
        comp[up]--;
        parts.push('Dealer busts from ' + upName(up) + ': ' + pct(BJ.dealerOutcomes(up, comp, S.rules, up === 1 || up === 10)[5], 0));
      }
      parts.push(countPart);
    }
    $('strip').innerHTML = '<span class="s-main">' + parts.filter(Boolean).join(' · ') + '</span><span class="s-more">More ▲</span>';
  }

  function openSheet(open) {
    $('rail').classList.toggle('open', open);
    $('sheet-backdrop').hidden = !open;
    $('strip').setAttribute('aria-expanded', String(open));
    if (open) $('log').scrollTop = $('log').scrollHeight;
  }
  $('strip').onclick = () => openSheet(true);
  $('sheet-close').onclick = () => openSheet(false);
  $('sheet-backdrop').onclick = () => openSheet(false);

  // Keep the phone layout sized to the real header and dock heights.
  function syncHeights() {
    const root = document.documentElement.style;
    root.setProperty('--head-h', document.querySelector('.top').offsetHeight + 'px');
    root.setProperty('--dock-h', $('dock').offsetHeight + 'px');
  }
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(syncHeights);
    ro.observe(document.querySelector('.top'));
    ro.observe($('dock'));
  }

  function addLog(kind, text) {
    logLines.push({ kind, text });
    if (logLines.length > 120) logLines.shift();
  }

  function flushEvents() {
    for (const e of table.takeEvents()) addLog(e.kind, e.text);
  }

  function renderLog() {
    const el = $('log');
    el.innerHTML = logLines.map((l) => '<div class="log-' + l.kind + '">' + esc(l.text) + '</div>').join('');
    el.scrollTop = el.scrollHeight;
  }

  function renderAll() {
    flushEvents();
    renderHeader();
    renderFelt();
    renderControls();
    renderOdds();
    renderCoach();
    renderCount();
    renderLog();
    renderStrip();
  }

  // ---------------------------------------------------------------------------
  // Game flow
  // ---------------------------------------------------------------------------

  async function run() {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        renderAll();
        const t = table;
        if (t.phase === 'insurance') break;
        if (t.phase === 'playing') {
          if (isHumanTurn()) break;
          if (S.speed) await wait(S.speed);
          if (t !== table) return;
          t.botStep();
        } else if (t.phase === 'dealer') {
          if (S.speed) await wait(S.speed * 0.8);
          if (t !== table) return;
          t.dealerStep();
        } else {
          if (t.phase === 'roundOver') roundOver();
          break;
        }
      }
    } finally {
      busy = false;
      renderAll();
    }
  }

  function roundOver() {
    if (!human.inRound) return;
    const last = history.length ? history[history.length - 1] : { b: human.roundStart, e: human.roundStart };
    const edge = BJ.houseEdgeEstimate(S.rules).total / 100;
    history.push({ b: human.bankroll, e: last.e - edge * human.roundBet });
    if (history.length > 1000) history.shift();
    human.inRound = false;
    roundSummary = human.roundNet;
    human.pendingBet = Math.min(lastBet, human.bankroll);
    save();
  }

  async function deal() {
    if (busy || (table.phase !== 'betting' && table.phase !== 'roundOver')) return;
    const bet = human.pendingBet;
    if (bet < S.minBet || bet > Math.min(S.maxBet, human.bankroll)) return;
    lastBet = bet;
    coachFeedback = null;
    coachShort = null;
    countCheck = null;
    roundSummary = null;
    if (table.shoe.cutCardOut || table.shoe.remaining < table.minCardsForRound()) {
      busy = true;
      $('shuffle-sub').textContent = S.rules.decks + ' decks go back into the shoe. The count starts again at 0.';
      $('shuffle-banner').hidden = false;
      await wait(S.speed ? 1400 : 300);
      $('shuffle-banner').hidden = true;
      busy = false;
    }
    if (!history.length) history.push({ b: human.bankroll, e: human.bankroll });
    table.startRound();
    run();
  }

  function humanAct(a) {
    if (busy || !isHumanTurn()) return;
    const av = table.available();
    if (!av[AVAIL_KEY[a]]) return;
    const odds = currentOdds();
    const fb = table.act(a);
    coachFeedback = S.coach === 'off' ? null : feedbackHTML(fb, odds);
    coachShort = S.coach === 'off' ? null : shortFeedback(fb, odds);
    run();
  }

  function humanInsurance(take) {
    if (table.phase !== 'insurance' || human.insuranceDecided) return;
    const tc = table.shoe.trueCount;
    const idx = table.seats.indexOf(human);
    table.decideInsurance(idx, take);
    if (S.coach !== 'off') {
      const good = tc >= 3;
      coachFeedback = take === good
        ? '<div class="coach-msg ok"><span class="coach-tag ok">Correct</span><strong>' + (take ? 'Insurance is a good bet at this count.' : 'No insurance.') + '</strong>' +
          (take ? 'At true count +3 or higher, more than 1 in 3 unseen cards are tens.' : 'Insurance is a side bet that loses money unless the count is high (true count +3 or more).') + '</div>'
        : '<div class="coach-msg bad"><span class="coach-tag bad">Not basic strategy</span><strong>' + (take ? 'Basic strategy never takes insurance.' : 'A counter takes insurance here.') + '</strong>' +
          (take ? 'Fewer than 1 in 3 unseen cards are tens, so this bet loses money on average. Even money is the same bet with a different name.' : 'The true count is +3 or higher, so more than 1 in 3 unseen cards are tens.') + '</div>';
    }
    coachShort = S.coach === 'off' ? null : (take === (tc >= 3)
      ? '<span class="ok">✓ Correct</span> ' + (take ? 'Insurance pays at this count.' : 'No insurance.')
      : '<span class="bad">✗ ' + (take ? 'Never take insurance without a high count.' : 'A counter takes insurance here.') + '</span>');
    run();
  }

  function rebuy() {
    human.bankroll += S.startBankroll;
    sessionStart += S.startBankroll;
    rebuys++;
    human.pendingBet = Math.min(lastBet, human.bankroll);
    const last = history.length ? history[history.length - 1] : { b: 0, e: 0 };
    history.push({ b: human.bankroll, e: last.e + S.startBankroll, rebuy: true });
    addLog('info', 'You buy in again for ' + money(S.startBankroll) + '.');
    save();
    renderAll();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') openSheet(false);
    if (view !== 'table' || e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (table.phase === 'insurance' && !human.insuranceDecided) {
      if (k === 'i') humanInsurance(true);
      if (k === 'n') humanInsurance(false);
      return;
    }
    if (ACTION_KEYS[k] && isHumanTurn()) { e.preventDefault(); humanAct(ACTION_KEYS[k]); return; }
    if (k === 'enter' && (table.phase === 'betting' || table.phase === 'roundOver') && !e.target.closest('button')) { e.preventDefault(); deal(); }
  });

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  const VIEWS = ['table', 'learn', 'sim', 'stats', 'setup'];
  function show(v) {
    if (!VIEWS.includes(v)) v = 'table';
    view = v;
    for (const name of VIEWS) {
      $('view-' + name).hidden = name !== v;
      $('tab-' + name).setAttribute('aria-selected', String(name === v));
    }
    if (v === 'learn') renderLearn();
    if (v === 'sim') renderSim();
    if (v === 'stats') renderStats();
    if (v === 'setup') renderSetup();
  }
  document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => show(b.dataset.view); });

  // ---------------------------------------------------------------------------
  // Learn
  // ---------------------------------------------------------------------------

  function strategyTable(title, rows, rowLabel) {
    const ups = [2, 3, 4, 5, 6, 7, 8, 9, 10, 1];
    const all = { double: true, split: true, surrender: S.rules.surrender };
    let html = '<div><h3>' + title + '</h3><div class="scroll"><table class="strat"><thead><tr><th></th>' +
      ups.map((u) => '<th>' + upName(u) + '</th>').join('') + '</tr></thead><tbody>';
    for (const cards of rows) {
      html += '<tr><th>' + rowLabel(cards) + '</th>';
      for (const u of ups) {
        let a = BJ.basicStrategy(cards, u, S.rules, all);
        let label = a;
        if (a === 'D' && BJ.basicStrategy(cards, u, S.rules, { double: false, split: true, surrender: S.rules.surrender }) === 'S') label = 'Ds';
        if (a === 'R' && BJ.basicStrategy(cards, u, S.rules, { double: true, split: true, surrender: false }) === 'S') label = 'Rs';
        html += '<td class="a-' + a + '" title="' + BJ.ACTION_NAMES[a] + '">' + label + '</td>';
      }
      html += '</tr>';
    }
    return html + '</tbody></table></div></div>';
  }

  function c(rank) { return { rank, suit: '♠', value: BJ.rankValue(rank) }; }

  function renderLearn() {
    const r = S.rules;
    const he = BJ.houseEdgeEstimate(r);
    const dt = BJ.dealerTable(r);
    const n = 52 * r.decks;
    const tens = 16 * r.decks;
    const pTen = tens / (n - 1);
    const hardRows = [];
    const hardPairs = { 5: ['2', '3'], 6: ['2', '4'], 7: ['2', '5'], 8: ['2', '6'], 9: ['2', '7'], 10: ['2', '8'], 11: ['2', '9'] };
    for (let t = 5; t <= 17; t++) hardRows.push((hardPairs[t] || ['10', String(t - 10)]).map(c));
    const softRows = ['2', '3', '4', '5', '6', '7', '8', '9'].map((x) => [c('A'), c(x)]);
    const pairRows = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'A'].map((x) => [c(x), c(x)]);
    const sim = simResults.find((s) => s.style === 'basic' && s.rulesKey === rulesKey(r));
    const bj32 = 25 * 1.5;
    const bjNow = 25 * r.blackjackPays;
    const mimic = simResults.find((s) => s.style === 'mimic' && s.rulesKey === rulesKey(r));

    $('view-learn').innerHTML =
      '<div><h2>How the casino beats you, and by how much</h2><p class="lead">Every number on this page comes from the rules you set in Settings. Change a rule and the numbers change.</p></div>' +

      '<div class="section"><h3>The house edge</h3>' +
      '<p>The <b>house edge</b> is the part of each bet that the casino keeps on average over many hands. With your rules and perfect basic strategy, it is about <b>' + he.total.toFixed(2) + '%</b>. For each $100 that you bet, you lose about ' + money(he.total) + ' on average. Any single session can go up or down by much more than that.</p>' +
      '<div class="scroll"><table class="data"><thead><tr><th>Rule</th><th>Effect on house edge</th></tr></thead><tbody>' +
      he.parts.map((p) => '<tr><td class="text">' + esc(p.label) + '</td><td>' + (p.value > 0 ? '+' : '') + p.value.toFixed(2) + '%</td></tr>').join('') +
      '<tr class="total"><td class="text">Your table</td><td>' + he.total.toFixed(2) + '%</td></tr></tbody></table></div>' +
      '<p class="note">These are approximate values from published rule tables. ' + (sim
        ? 'Your simulator run of ' + sim.rounds.toLocaleString() + ' hands measured ' + (sim.edge * 100).toFixed(2) + '% ± ' + (sim.se * 196).toFixed(2) + '%.'
        : 'Use the Simulator tab to measure it yourself.') + '</p></div>' +

      '<div class="section"><h3>Why the dealer has the edge</h3>' +
      '<p>The dealer and you follow almost the same game, with one big difference: <b>you play first</b>. If you bust, you lose at once. The dealer can bust later in the same hand, but your bet is already gone. That one rule gives the casino about an 8% edge.</p>' +
      '<p>You get most of that back with things the dealer cannot do: blackjack pays ' + payoutName(r.blackjackPays) + ', you can double, split and surrender, and you can stand on a low total. A player who copies the dealer (hit to 17, never double or split) loses about 5.5% ' + (mimic ? '(your simulator measured ' + (mimic.edge * 100).toFixed(1) + '%)' : '') + '. Basic strategy brings that down to ' + he.total.toFixed(2) + '%.</p>' +
      '<div class="scroll"><table class="data"><thead><tr><th>Your hard total</th>' + [12, 13, 14, 15, 16, 17, 18, 19, 20].map((t) => '<th>' + t + '</th>').join('') + '</tr></thead><tbody>' +
      '<tr><td class="text">Chance one hit busts you</td>' + [12, 13, 14, 15, 16, 17, 18, 19, 20].map((t) => '<td>' + pct(BJ.bustChanceFresh(t, r.decks), 0) + '</td>').join('') + '</tr></tbody></table></div></div>' +

      '<div class="section"><h3>What the dealer\'s up card tells you</h3>' +
      '<p>The dealer must hit until 17 or more' + (r.hitSoft17 ? ' and must also hit soft 17' : ' and stands on soft 17') + '. So the up card predicts the result. A dealer 4, 5 or 6 busts about 40% of the time. A dealer 10 or Ace busts much less often.</p>' +
      '<div class="scroll"><table class="data"><thead><tr><th>Up card</th><th>17</th><th>18</th><th>19</th><th>20</th><th>21</th><th>Bust</th></tr></thead><tbody>' +
      dt.map((row) => '<tr><td>' + upName(row.up) + '</td>' + row.dist.map((x) => '<td>' + pct(x) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table></div><p class="note">Fresh ' + r.decks + '-deck shoe. For a 10 or Ace, the dealer has already checked for blackjack and does not have it.</p></div>' +

      '<div class="section"><h3>Basic strategy for your rules</h3>' +
      '<p><b>Basic strategy</b> is the best move for each hand against each dealer up card. A computer finds it by playing out every case. It does not use the count. Read your hand on the left and the dealer\'s up card at the top.</p>' +
      '<div class="chart-grid">' +
      strategyTable('Hard totals', hardRows, (cs) => { const t = BJ.handTotal(cs).total; return t === 17 ? '17+' : String(t); }) +
      strategyTable('Soft totals', softRows, (cs) => 'A,' + cs[1].rank) +
      strategyTable('Pairs', pairRows, (cs) => cs[0].rank + ',' + cs[1].rank) +
      '</div><div class="legend">' +
      '<span><i class="a-H">H</i>Hit</span><span><i class="a-S">S</i>Stand</span><span><i class="a-D">D</i>Double, else hit</span><span><i class="a-D">Ds</i>Double, else stand</span>' +
      '<span><i class="a-P">P</i>Split</span>' + (r.surrender ? '<span><i class="a-R">R</i>Surrender, else hit</span><span><i class="a-R">Rs</i>Surrender, else stand</span>' : '') + '</div>' +
      '<p class="note">Hard 4 (2,2 that you do not split) and lower: always hit. Hard 18 and higher: always stand. Soft 20 and higher: always stand.</p></div>' +

      '<div class="section"><h3>Card counting</h3>' +
      '<p>Cards that are already played do not come back until the shuffle. When many low cards are gone, the shoe is rich in tens and Aces. That helps you: you get more blackjacks (paid ' + payoutName(r.blackjackPays) + '), your doubles land on 10s, and the dealer busts more.</p>' +
      '<p>The <b>Hi-Lo</b> count tracks this with one number. Add +1 for each 2, 3, 4, 5 or 6 that you see. Add 0 for 7, 8 or 9. Add −1 for each 10, J, Q, K or Ace. That total is the <b>running count</b>. Divide it by the decks left in the shoe to get the <b>true count</b>. For example, running count +6 with 3 decks left is true count +2.</p>' +
      '<p>Each +1 of true count moves about 0.5% of edge to you. At your table you break even near true count +' + Math.max(0, he.total / 0.5).toFixed(1) + '. A counter bets the minimum when the count is low and bets more when it is high. The Card counter bot at the table bets 1 unit up to true count +1, then 2, 4, 6 and 8 units at +2, +3, +4 and +5.</p>' +
      '<p>Casinos defend against counters with the <b>cut card</b>. They shuffle with cards still in the shoe, so the high counts at the end never come. Your shoe shuffles at ' + Math.round(r.penetration * 100) + '% (this is called <b>penetration</b>). Counting in your head is legal, but a casino can refuse your bets.</p></div>' +

      '<div class="section"><h3>Insurance and even money</h3>' +
      '<p>When the dealer shows an Ace, you can bet half of your bet that the dealer has blackjack. It pays 2 to 1. You need more than 1 in 3 unseen cards to be tens to profit. A fresh ' + r.decks + '-deck shoe has ' + tens + ' tens in ' + (n - 1) + ' unseen cards: ' + pct(pTen) + '. So insurance loses about ' + pct(1 - 3 * pTen) + ' of each insurance bet. Take it only at a true count of +3 or more.</p>' +
      '<p><b>Even money</b> is the same insurance bet, offered when you have blackjack. It is a bad deal for the same reason.</p></div>' +

      '<div class="section"><h3>Rules that change your odds</h3><ul>' +
      '<li><b>6 to 5 blackjack:</b> a $25 blackjack pays $30 instead of $' + bj32.toFixed(2) + '. This adds about 1.4% to the house edge, more than any other common rule.' + (r.blackjackPays !== 1.5 ? ' Your table pays $' + bjNow.toFixed(2) + '.' : '') + '</li>' +
      '<li><b>Dealer hits soft 17:</b> adds about 0.2%. The dealer turns some 17s into better hands.</li>' +
      '<li><b>More decks:</b> each extra deck adds a little. A single deck is about 0.5% better than eight decks.</li>' +
      '<li><b>Surrender:</b> lets you give up a bad hand for half your bet. It saves about 0.07%.</li>' +
      '<li><b>Double after split:</b> saves about 0.14%.</li></ul>' +
      '<p class="note">Look for the sign on the felt. It shows the blackjack payout and the soft 17 rule.</p></div>' +

      '<div class="section"><h3>Words used in this game</h3><dl class="gloss">' +
      [
        ['Shoe', 'The box that holds the shuffled decks. This table uses ' + r.decks + '.'],
        ['Cut card', 'A plastic card that the dealer puts in the shoe. When it comes out, the dealer finishes the hand and shuffles.'],
        ['Penetration', 'How far into the shoe the cut card sits, as a percent of all cards.'],
        ['Burn card', 'The first card after a shuffle. The dealer discards it face down.'],
        ['Up card / hole card', 'The dealer\'s face-up card and face-down card.'],
        ['Peek', 'With a 10 or Ace up, the dealer checks the hole card for blackjack before you play.'],
        ['Hard hand', 'A hand with no Ace, or with Aces that must count as 1.'],
        ['Soft hand', 'A hand with an Ace that counts as 11. One more card cannot bust it.'],
        ['Blackjack (natural)', 'An Ace and a ten-value card as your first two cards. It pays ' + payoutName(r.blackjackPays) + '.'],
        ['Bust', 'A total over 21. The hand loses at once.'],
        ['Push', 'A tie. You keep your bet.'],
        ['Hit / Stand', 'Take another card / take no more cards.'],
        ['Double down', 'Double your bet and take exactly one more card.'],
        ['Split', 'Turn a pair into two hands, each with its own bet.'],
        ['Surrender', 'Give up the hand and get back half your bet. Only as your first move.'],
        ['Insurance', 'A side bet that the dealer has blackjack when the up card is an Ace.'],
        ['House edge', 'The casino\'s average profit as a percent of your first bet.'],
        ['Expected value (EV)', 'Your average result for a move if you could repeat it many times. +10% means you win 10 cents per $1 on average.'],
        ['Basic strategy', 'The move with the best EV for each hand, with no count.'],
        ['Running count / true count', 'The Hi-Lo total of seen cards, and that total divided by decks left.'],
        ['First base / third base', 'The first seat to play (dealer\'s left) and the last seat to play (dealer\'s right).'],
        ['Variance', 'How far real results swing away from the average. In blackjack it is large compared to the house edge.'],
      ].map(([t, d]) => '<dt>' + esc(t) + '</dt><dd>' + esc(d) + '</dd>').join('') + '</dl></div>';
  }

  // ---------------------------------------------------------------------------
  // Simulator
  // ---------------------------------------------------------------------------

  let simRunning = false;

  function rulesKey(r) {
    return [r.decks, r.hitSoft17 ? 'H17' : 'S17', r.blackjackPays, r.doubleAfterSplit ? 'DAS' : 'noDAS', r.surrender ? 'LS' : 'noLS', r.maxHands, r.resplitAces ? 'RSA' : '', r.penetration].join('|');
  }

  function rulesText(r) {
    return r.decks + ' decks, ' + (r.hitSoft17 ? 'H17' : 'S17') + ', ' + payoutName(r.blackjackPays).replace(' to ', ':') + (r.doubleAfterSplit ? ', DAS' : '') + (r.surrender ? ', surrender' : '');
  }

  function renderSim() {
    const el = $('view-sim');
    if (!$('sim-run')) {
      el.innerHTML =
        '<div><h2>Play 1,000,000 hands in a few seconds</h2><p class="lead">Short sessions are mostly luck. The simulator plays many hands with your current rules, so the luck averages out and the real edge shows.</p></div>' +
        '<div class="section"><div class="form-grid">' +
        '<div class="field"><label for="sim-style">Strategy</label><select id="sim-style"><option value="all">Compare all four</option>' +
        Object.keys(BJ.BOT_STYLES).map((k) => '<option value="' + k + '">' + BJ.BOT_STYLES[k].label + '</option>').join('') + '</select><small id="sim-blurb"></small></div>' +
        '<div class="field"><label for="sim-hands">Hands per strategy</label><select id="sim-hands"><option value="10000">10,000</option><option value="100000" selected>100,000</option><option value="1000000">1,000,000</option></select><small>More hands give a narrower range.</small></div>' +
        '<div class="field"><label for="sim-bet">Your bet per hand ($)</label><input id="sim-bet" type="number" min="1" value="25"><small>Used for the dollar figures.</small></div>' +
        '<div class="field"><label for="sim-hph">Hands per hour</label><input id="sim-hph" type="number" min="1" value="70"><small>About 70 at a busy table, 200 alone with the dealer.</small></div>' +
        '</div><div class="row" style="margin-top:14px"><button class="btn primary" id="sim-run">Run simulation</button><span class="hint" id="sim-status"></span></div>' +
        '<div class="progress" style="margin-top:10px"><div id="sim-progress"></div></div></div>' +
        '<div class="section"><h3>Results</h3><div id="sim-results"></div></div>';
      $('sim-run').onclick = startSim;
      $('sim-style').onchange = simBlurb;
      $('sim-bet').oninput = renderSimResults;
      $('sim-hph').oninput = renderSimResults;
    }
    simBlurb();
    $('sim-status').textContent = simRunning ? $('sim-status').textContent : 'Rules: ' + rulesText(S.rules) + ' (change them in Settings).';
    renderSimResults();
  }

  function simBlurb() {
    const v = $('sim-style').value;
    $('sim-blurb').textContent = v === 'all' ? 'Runs each strategy one after another.' : BJ.BOT_STYLES[v].blurb;
  }

  function renderSimResults() {
    const out = $('sim-results');
    if (!out) return;
    if (!simResults.length) {
      out.innerHTML = '<p class="note">No runs yet. Try "Compare all four" with 100,000 hands. It takes a few seconds.</p>';
      return;
    }
    const bet = Math.max(1, Number($('sim-bet').value) || 25);
    const hph = Math.max(1, Number($('sim-hph').value) || 70);
    out.innerHTML = '<div class="scroll"><table class="data"><thead><tr><th>Strategy</th><th>Rules</th><th>Hands</th><th>House edge</th><th>95% range</th><th>Per hour</th><th>Per 1,000 hands</th></tr></thead><tbody>' +
      simResults.map((s) => {
        const perHour = -s.edge * bet * hph;
        return '<tr><td class="text">' + BJ.BOT_STYLES[s.style].label + '</td><td class="text">' + esc(s.rules) + '</td><td>' + s.rounds.toLocaleString() + '</td>' +
          '<td class="' + (s.edge > 0 ? 'neg' : 'pos') + '">' + (s.edge * 100).toFixed(2) + '%</td>' +
          '<td>' + ((s.edge - 1.96 * s.se) * 100).toFixed(2) + '% to ' + ((s.edge + 1.96 * s.se) * 100).toFixed(2) + '%</td>' +
          '<td class="' + (perHour < 0 ? 'neg' : 'pos') + '">' + signedMoney(Math.round(perHour)) + '</td>' +
          '<td class="' + (perHour < 0 ? 'neg' : 'pos') + '">' + signedMoney(Math.round(-s.edge * bet * 1000)) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="note">House edge = money lost ÷ money bet on the first bet of each hand. A negative edge means the player wins. The 95% range shows where the true value very likely sits. Results swing hard: one standard deviation is about ' + (simResults[0].sd ? simResults[0].sd.toFixed(2) : '1.15') + ' bets per hand. The counter\'s dollar figures assume a flat bet, but a counter bets more when the count is high.</p>' +
      '<div class="row"><button class="btn" id="sim-clear">Clear results</button></div>';
    $('sim-clear').onclick = () => { simResults = []; save(); renderSimResults(); };
  }

  async function startSim() {
    if (simRunning) return;
    simRunning = true;
    $('sim-run').disabled = true;
    const v = $('sim-style').value;
    const styles = v === 'all' ? Object.keys(BJ.BOT_STYLES) : [v];
    const hands = Number($('sim-hands').value);
    const rules = Object.assign({}, S.rules);
    const total = hands * styles.length;
    let doneAll = 0;
    const t0 = performance.now();
    for (const style of styles) {
      const sim = new BJ.Simulator(rules, style);
      let done = 0;
      while (done < hands) {
        const chunk = Math.min(8000, hands - done);
        sim.run(chunk);
        done += chunk;
        doneAll += chunk;
        const p = $('sim-progress');
        if (p) p.style.width = (doneAll / total * 100).toFixed(1) + '%';
        const st = $('sim-status');
        if (st) st.textContent = BJ.BOT_STYLES[style].label + ': ' + done.toLocaleString() + ' hands';
        await wait(0);
      }
      const r = sim.result();
      simResults.unshift({ style, rules: rulesText(rules), rulesKey: rulesKey(rules), rounds: r.rounds, edge: r.edge, se: r.se, sd: r.sd });
      renderSimResults();
    }
    simResults = simResults.slice(0, 30);
    save();
    simRunning = false;
    if ($('sim-run')) $('sim-run').disabled = false;
    if ($('sim-progress')) $('sim-progress').style.width = '100%';
    if ($('sim-status')) $('sim-status').textContent = 'Done: ' + total.toLocaleString() + ' hands in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s.';
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  function bankrollChart() {
    if (history.length < 2) return '<p class="note">Play a few hands to see your bankroll chart.</p>';
    const W = 640, H = 220, L = 56, R = 12, T = 12, B = 26;
    const ys = history.flatMap((h) => [h.b, h.e]);
    let lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
    if (hi - lo < 50) { hi += 25; lo -= 25; }
    const step = niceStep((hi - lo) / 4);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const n = history.length - 1;
    const x = (i) => L + (W - L - R) * (i / n);
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    let grid = '';
    for (let v = lo; v <= hi + 1e-9; v += step) {
      grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>' +
        '<text x="' + (L - 6) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end" font-size="11" fill="var(--muted)" font-family="var(--font-mono)">' + money(v) + '</text>';
    }
    const line = (key) => history.map((h, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(h[key]).toFixed(1)).join(' ');
    const area = line('b') + ' L' + x(n).toFixed(1) + ' ' + (H - B) + ' L' + L + ' ' + (H - B) + ' Z';
    const last = history[n];
    return '<div class="legend" style="margin:0 0 6px"><span><svg width="18" height="8" aria-hidden="true"><line x1="0" x2="18" y1="4" y2="4" stroke="var(--accent)" stroke-width="2"/></svg>Your bankroll</span>' +
      '<span><svg width="18" height="8" aria-hidden="true"><line x1="0" x2="18" y1="4" y2="4" stroke="var(--muted)" stroke-width="2" stroke-dasharray="4 3"/></svg>Expected path with the house edge</span></div>' +
      '<div class="chart-wrap" id="chart-wrap"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Bankroll after each hand">' + grid +
      '<path d="' + area + '" fill="color-mix(in oklab, var(--accent) 14%, transparent)" stroke="none"/>' +
      '<path d="' + line('e') + '" fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="4 3"/>' +
      '<path d="' + line('b') + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>' +
      '<circle cx="' + x(n).toFixed(1) + '" cy="' + y(last.b).toFixed(1) + '" r="4" fill="var(--accent)" stroke="var(--panel)" stroke-width="2"/>' +
      '<text x="' + L + '" y="' + (H - 8) + '" font-size="11" fill="var(--muted)">Hand 1</text>' +
      '<text x="' + (W - R) + '" y="' + (H - 8) + '" text-anchor="end" font-size="11" fill="var(--muted)">Hand ' + n + '</text>' +
      '<line id="chart-cross" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--muted)" stroke-width="1" visibility="hidden"/>' +
      '<rect id="chart-hit" x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '" fill="transparent"/>' +
      '</svg><div class="chart-tip" id="chart-tip" hidden></div></div>';
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  function wireChart() {
    const hit = $('chart-hit');
    if (!hit) return;
    const svg = hit.ownerSVGElement;
    const W = 640, L = 56, R = 12;
    const n = history.length - 1;
    const move = (ev) => {
      const box = svg.getBoundingClientRect();
      const sx = (ev.clientX - box.left) / box.width * W;
      const i = Math.max(0, Math.min(n, Math.round((sx - L) / (W - L - R) * n)));
      const px = L + (W - L - R) * (i / n);
      const cross = $('chart-cross');
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      const tip = $('chart-tip');
      tip.hidden = false;
      tip.style.left = (px / W * box.width) + 'px';
      tip.style.top = '30px';
      tip.textContent = 'Hand ' + i + ': ' + money(history[i].b) + ' (expected ' + money(Math.round(history[i].e)) + ')';
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', () => { $('chart-tip').hidden = true; $('chart-cross').setAttribute('visibility', 'hidden'); });
  }

  let resetArmed = false;

  function renderStats() {
    const st = human.stats;
    const he = BJ.houseEdgeEstimate(S.rules).total / 100;
    const n = st.rounds;
    const actual = st.initialWagered ? -st.net / st.initialWagered : 0;
    const mean = n ? st.sumUnits / n : 0;
    const sd = n > 1 ? Math.sqrt(Math.max(0, (st.sumSq - n * mean * mean) / (n - 1))) : 1.15;
    const se = n ? sd / Math.sqrt(n) : 0;
    const decided = st.wins + st.losses + st.pushes;
    const bots = table.seats.filter((s) => s !== human);

    $('view-stats').innerHTML =
      '<div><h2>Your results against the math</h2><p class="lead">Luck rules the short run. The house edge rules the long run. Here you can see both.</p></div>' +
      '<div class="tiles">' +
      '<div class="tile"><span>Net result</span><b class="' + (st.net >= 0 ? 'pos' : 'neg') + '">' + signedMoney(st.net) + '</b><small>' + n.toLocaleString() + ' rounds, ' + money(st.initialWagered) + ' bet</small></div>' +
      '<div class="tile"><span>Your edge so far</span><b class="' + (actual > 0 ? 'neg' : 'pos') + '">' + (n ? (-actual * 100).toFixed(2) + '%' : '—') + '</b><small>Math says ' + (-he * 100).toFixed(2) + '%' + (n ? ', ± ' + (se * 196).toFixed(1) + '% luck' : '') + '</small></div>' +
      '<div class="tile"><span>Win / push / lose</span><b>' + (decided ? pct(st.wins / decided, 0) + ' / ' + pct(st.pushes / decided, 0) + ' / ' + pct(st.losses / decided, 0) : '—') + '</b><small>' + st.blackjacks + ' blackjacks, ' + st.busts + ' busts</small></div>' +
      '<div class="tile"><span>Strategy accuracy</span><b>' + (st.decisions ? pct(st.correct / st.decisions, 0) : '—') + '</b><small>' + st.correct + ' of ' + st.decisions + ' moves</small></div>' +
      '</div>' +
      '<div class="section"><h3>Bankroll</h3>' + bankrollChart() +
      '<p class="note">The dashed line is where the house edge alone would put you. Your real line swings around it. After a few hundred hands the swing is usually much bigger than the edge. Over many thousands of hands, the edge wins. ' + (rebuys ? 'You bought in again ' + rebuys + ' time' + (rebuys > 1 ? 's' : '') + '.' : '') + '</p></div>' +
      '<div class="section"><h3>Moves to review</h3>' + (st.mistakes.length
        ? '<div class="scroll"><table class="data"><thead><tr><th>Your hand</th><th>Dealer</th><th>You did</th><th>Basic strategy</th></tr></thead><tbody>' +
          st.mistakes.slice(-12).reverse().map((m) => '<tr><td class="text">' + esc(m.hand) + '</td><td>' + esc(m.up) + '</td><td class="text">' + esc(m.did) + '</td><td class="text">' + esc(m.should) + '</td></tr>').join('') + '</tbody></table></div>'
        : '<p class="note">No mistakes recorded yet.</p>') + '</div>' +
      '<div class="section"><h3>The other players this session</h3>' + (bots.length
        ? '<div class="scroll"><table class="data"><thead><tr><th>Player</th><th>Style</th><th>Rounds</th><th>Net</th><th>Result per bet</th></tr></thead><tbody>' +
          bots.map((b) => '<tr><td class="text">' + esc(b.name) + '</td><td class="text">' + BJ.BOT_STYLES[b.style].label + '</td><td>' + b.stats.rounds + '</td><td class="' + (b.stats.net >= 0 ? 'pos' : 'neg') + '">' + signedMoney(b.stats.net) + '</td><td>' +
            (b.stats.initialWagered ? signedPct(b.stats.net / b.stats.initialWagered, 1) : '—') + '</td></tr>').join('') + '</tbody></table></div>' +
          '<p class="note">A few hundred hands cannot rank these styles. The Simulator can.</p>'
        : '<p class="note">No computer players. Add some in Settings.</p>') + '</div>' +
      '<div class="row"><button class="btn" id="reset-stats">' + (resetArmed ? 'Click again to reset bankroll and stats' : 'Reset bankroll and stats') + '</button></div>';
    wireChart();
    $('reset-stats').onclick = () => {
      if (!resetArmed) { resetArmed = true; renderStats(); return; }
      resetArmed = false;
      if (table.phase !== 'betting' && table.phase !== 'roundOver') { renderStats(); return; }
      human.stats = BJ.newStats();
      human.bankroll = S.startBankroll;
      human.stats.peakBankroll = human.bankroll;
      human.stats.lowBankroll = human.bankroll;
      human.pendingBet = Math.min(lastBet, human.bankroll);
      sessionStart = human.bankroll;
      rebuys = 0;
      history = [];
      save();
      renderAll();
      renderStats();
    };
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  let draft = null;
  let setupMsg = '';

  function renderSetup() {
    if (!draft) draft = JSON.parse(JSON.stringify(S));
    const r = draft.rules;
    const sel = (id, opts, val) => '<select id="' + id + '">' + opts.map(([v, l]) => '<option value="' + v + '"' + (String(v) === String(val) ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>';
    const chk = (id, val, label, help) => '<div class="field check"><input type="checkbox" id="' + id + '"' + (val ? ' checked' : '') + '><div><label for="' + id + '">' + label + '</label><br><small>' + help + '</small></div></div>';
    const nSeats = draft.bots.length + 1;
    const he = BJ.houseEdgeEstimate(r).total;

    $('view-setup').innerHTML =
      '<div><h2>Set up your table</h2><p class="lead">Changes start a new shoe. Your bankroll and stats stay.</p></div>' +
      '<div class="section"><h3>Casino rules</h3><p class="note">House edge with these rules: <b>' + he.toFixed(2) + '%</b></p><div class="form-grid">' +
      '<div class="field"><label for="set-decks">Decks in the shoe</label>' + sel('set-decks', [1, 2, 4, 5, 6, 8].map((d) => [d, d + (d === 1 ? ' deck' : ' decks')]), r.decks) + '<small>Fewer decks are slightly better for you.</small></div>' +
      '<div class="field"><label for="set-s17">Dealer on soft 17</label>' + sel('set-s17', [['s', 'Stands (better for you)'], ['h', 'Hits']], r.hitSoft17 ? 'h' : 's') + '<small>Soft 17 is a 17 with an Ace counted as 11.</small></div>' +
      '<div class="field"><label for="set-pay">Blackjack pays</label>' + sel('set-pay', [[1.5, '3 to 2'], [1.2, '6 to 5'], [1, '1 to 1']], r.blackjackPays) + '<small>6 to 5 is common on the Las Vegas Strip now. Avoid it.</small></div>' +
      '<div class="field"><label for="set-maxh">Split up to</label>' + sel('set-maxh', [[2, '2 hands'], [3, '3 hands'], [4, '4 hands']], r.maxHands) + '</div>' +
      '<div class="field"><label for="set-pen">Cut card at <span id="pen-out">' + Math.round(r.penetration * 100) + '%</span> of the shoe</label><input type="range" id="set-pen" min="50" max="85" step="5" value="' + Math.round(r.penetration * 100) + '"><small>Deeper cut = more cards before the shuffle. Good for counters.</small></div>' +
      chk('set-das', r.doubleAfterSplit, 'Double after split', 'You can double on a hand that came from a split.') +
      chk('set-sur', r.surrender, 'Late surrender', 'Give up your first two cards for half your bet, after the dealer checks for blackjack.') +
      chk('set-rsa', r.resplitAces, 'Re-split Aces', 'If a split Ace gets another Ace, you can split again.') +
      '</div></div>' +

      '<div class="section"><h3>Players at the table</h3><div class="form-grid">' +
      '<div class="field"><label for="set-nbots">Computer players</label>' + sel('set-nbots', [0, 1, 2, 3, 4, 5, 6].map((x) => [x, String(x)]), draft.bots.length) + '<small>They use cards from the same shoe, as in a real casino.</small></div>' +
      '<div class="field"><label for="set-seat">Your seat</label>' + sel('set-seat', Array.from({ length: nSeats }, (_, i) => [i, 'Seat ' + (i + 1) + (nSeats > 1 && i === 0 ? ' (first base, plays first)' : nSeats > 1 && i === nSeats - 1 ? ' (third base, plays last)' : '')]), Math.min(draft.seatPos, nSeats - 1)) + '<small>Your seat does not change your odds. Other players\' moves do not either, on average.</small></div>' +
      '<div class="field"><label for="set-botbet">Computer players bet</label>' + sel('set-botbet', [[5, '$5'], [10, '$10'], [25, '$25'], [100, '$100']], draft.botBet) + '</div>' +
      '<div class="field"><label for="set-speed">Dealing speed</label>' + sel('set-speed', [[1100, 'Slow'], [650, 'Normal'], [250, 'Fast'], [0, 'Instant']], draft.speed) + '</div>' +
      '</div><div class="bots" style="margin-top:12px">' +
      draft.bots.map((b, i) => '<div class="row"><label for="set-bot-' + i + '" style="min-width:70px">' + BJ.BOT_NAMES[i] + '</label>' + sel('set-bot-' + i, Object.keys(BJ.BOT_STYLES).map((k) => [k, BJ.BOT_STYLES[k].label + ': ' + BJ.BOT_STYLES[k].blurb]), b) + '</div>').join('') +
      '</div></div>' +

      '<div class="section"><h3>Teaching tools</h3><div class="form-grid">' +
      chk('set-odds', draft.showOdds, 'Live odds panel', 'Shows the expected value of each move and the chance to bust.') +
      '<div class="field"><label for="set-coach">Strategy coach</label>' + sel('set-coach', [['hint', 'Show the best move before I act'], ['after', 'Tell me after I act'], ['off', 'Off']], draft.coach) + '</div>' +
      chk('set-count', draft.showCount, 'Show the count', 'Turn this off to practice counting. You can check your count at any time.') +
      '<div class="field"><label for="set-bank">Buy-in amount ($)</label><input type="number" id="set-bank" min="100" step="100" value="' + draft.startBankroll + '"><small>Used when you buy in again or reset.</small></div>' +
      '</div></div>' +
      '<div class="row"><button class="btn primary" id="set-apply">Apply and start a new shoe</button><button class="btn" id="set-default">Use default settings</button><span class="hint" id="set-msg">' + esc(setupMsg) + '</span></div>';

    const readDraft = () => {
      r.decks = Number($('set-decks').value);
      r.hitSoft17 = $('set-s17').value === 'h';
      r.blackjackPays = Number($('set-pay').value);
      r.maxHands = Number($('set-maxh').value);
      r.penetration = Number($('set-pen').value) / 100;
      r.doubleAfterSplit = $('set-das').checked;
      r.surrender = $('set-sur').checked;
      r.resplitAces = $('set-rsa').checked;
      const nb = Number($('set-nbots').value);
      const bots = draft.bots.map((_, i) => ($('set-bot-' + i) ? $('set-bot-' + i).value : 'basic'));
      const defaults = ['basic', 'mimic', 'counter', 'nobust', 'basic', 'mimic'];
      while (bots.length < nb) bots.push(defaults[bots.length]);
      draft.bots = bots.slice(0, nb);
      draft.seatPos = Math.min(Number($('set-seat').value), draft.bots.length);
      draft.botBet = Number($('set-botbet').value);
      draft.speed = Number($('set-speed').value);
      draft.showOdds = $('set-odds').checked;
      draft.coach = $('set-coach').value;
      draft.showCount = $('set-count').checked;
      draft.startBankroll = Math.max(100, Number($('set-bank').value) || 1000);
    };
    $('view-setup').onchange = (e) => {
      readDraft();
      setupMsg = 'Not applied yet.';
      if (e.target.id === 'set-nbots' || e.target.id.startsWith('set-') && ['set-decks', 'set-s17', 'set-pay', 'set-das', 'set-sur', 'set-rsa', 'set-maxh'].includes(e.target.id)) renderSetup();
      else $('set-msg').textContent = setupMsg;
    };
    $('set-pen').oninput = () => { $('pen-out').textContent = $('set-pen').value + '%'; };
    $('set-apply').onclick = () => {
      readDraft();
      if (table.phase !== 'betting' && table.phase !== 'roundOver') {
        setupMsg = 'Finish the current hand first, then apply.';
        $('set-msg').textContent = setupMsg;
        return;
      }
      Object.assign(S, JSON.parse(JSON.stringify(draft)));
      save();
      buildTable();
      renderAll();
      setupMsg = 'Applied. New shoe shuffled.';
      draft = null;
      renderSetup();
    };
    $('set-default').onclick = () => {
      draft = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      setupMsg = 'Defaults loaded. Not applied yet.';
      renderSetup();
    };
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  buildTable();
  renderAll();
  show((location.hash || '').slice(1) || 'table');
})();
