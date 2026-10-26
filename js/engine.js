/*
 * Blackjack engine: shoe, rules, basic strategy, odds math, card counting,
 * and the table flow. It has no DOM code, so the browser page and the Node
 * tests use the same file.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Cards and shoe
  // ---------------------------------------------------------------------------

  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const SUITS = ['♠', '♥', '♦', '♣'];

  // Blackjack value of a rank. An ace is 1 here; handTotal() makes it 11 when it can.
  function rankValue(rank) {
    if (rank === 'A') return 1;
    if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
    return Number(rank);
  }

  // Hi-Lo count tag: low cards (2-6) help the dealer, so they leave the shoe as +1.
  // Tens and aces help the player, so they leave as -1.
  function hiLo(value) {
    if (value >= 2 && value <= 6) return 1;
    if (value === 10 || value === 1) return -1;
    return 0;
  }

  // Small seeded random generator, so the tests can repeat a shuffle.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Shoe {
    constructor(decks, penetration, rng) {
      this.decks = decks;
      this.penetration = penetration;
      this.rng = rng || Math.random;
      this.shuffleCount = 0;
      this.shuffle();
    }

    shuffle() {
      const cards = [];
      // Ids stay unique across shuffles, so a card still on the table after an
      // emergency reshuffle never shares an id with a card in the new shoe.
      let id = this.shuffleCount * 1000;
      for (let d = 0; d < this.decks; d++) {
        for (const suit of SUITS) {
          for (const rank of RANKS) {
            cards.push({ id: id++, rank, suit, value: rankValue(rank) });
          }
        }
      }
      // Fisher-Yates shuffle: every order of the cards is equally likely.
      for (let i = cards.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        const tmp = cards[i];
        cards[i] = cards[j];
        cards[j] = tmp;
      }
      this.cards = cards;
      this.cutIndex = Math.floor(cards.length * this.penetration);
      this.runningCount = 0;
      this.discards = 0;
      // The dealer burns (discards face down) the first card after a shuffle.
      this.burned = cards[0];
      this.pos = 1;
      this.discards = 1;
      this.shuffleCount++;
    }

    get total() { return this.cards.length; }
    get remaining() { return this.cards.length - this.pos; }
    get decksRemaining() { return this.remaining / 52; }
    get cutCardOut() { return this.pos >= this.cutIndex; }

    // True count = running count per deck that is left. Uses at least half a deck
    // so the number does not explode at the very end of a shoe.
    get trueCount() {
      return this.runningCount / Math.max(this.decksRemaining, 0.5);
    }

    draw() {
      if (this.pos >= this.cards.length) {
        // Only happens with very deep penetration and many split hands.
        this.shuffle();
      }
      return this.cards[this.pos++];
    }

    // Call when a card becomes visible to the table.
    see(card) {
      this.runningCount += hiLo(card.value);
    }

    // Number of undealt cards of each value. Index 1 = ace, 10 = all ten-value cards.
    composition() {
      const comp = new Array(11).fill(0);
      for (let i = this.pos; i < this.cards.length; i++) comp[this.cards[i].value]++;
      return comp;
    }
  }

  // ---------------------------------------------------------------------------
  // Hands
  // ---------------------------------------------------------------------------

  // Returns the best total and if the hand is "soft" (an ace counts as 11).
  function handTotal(cards) {
    let total = 0;
    let aces = 0;
    for (const c of cards) {
      total += c.value;
      if (c.value === 1) aces++;
    }
    let soft = false;
    if (aces > 0 && total + 10 <= 21) {
      total += 10;
      soft = true;
    }
    return { total, soft };
  }

  function isNatural(cards) {
    return cards.length === 2 && handTotal(cards).total === 21;
  }

  function newHand(bet) {
    return {
      cards: [],
      bet,
      doubled: false,
      fromSplit: false,
      splitAces: false,
      surrendered: false,
      done: false,
      result: null,
      net: 0,
    };
  }

  function handIsBlackjack(hand) {
    return !hand.fromSplit && isNatural(hand.cards);
  }

  function handIsBust(hand) {
    return handTotal(hand.cards).total > 21;
  }

  function describeHand(cards) {
    const { total, soft } = handTotal(cards);
    if (total > 21) return 'bust with ' + total;
    if (isNatural(cards)) return 'blackjack';
    return (soft ? 'soft ' : '') + total;
  }

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  const DEFAULT_RULES = {
    decks: 5,
    hitSoft17: false,     // false = dealer stands on soft 17 (better for you)
    blackjackPays: 1.5,   // 1.5 = 3:2, 1.2 = 6:5
    doubleAfterSplit: true,
    surrender: true,      // late surrender: give up half the bet after the dealer checks for blackjack
    maxHands: 4,          // split up to 4 hands
    resplitAces: false,
    penetration: 0.75,    // cut card at 75% of the shoe
  };

  // Approximate house edge from published rule-effect tables (Wizard of Odds style).
  // Values are percent of the first bet, for a player who uses perfect basic strategy.
  function houseEdgeEstimate(rules) {
    const parts = [];
    parts.push({ label: 'Base game: 8 decks, dealer stands on soft 17, double after split, 3:2 blackjack', value: 0.43 });
    const deckEffect = { 1: -0.48, 2: -0.19, 3: -0.10, 4: -0.06, 5: -0.03, 6: -0.02, 7: -0.01, 8: 0 };
    const de = deckEffect[rules.decks] !== undefined ? deckEffect[rules.decks] : 0;
    if (de !== 0) parts.push({ label: rules.decks + (rules.decks === 1 ? ' deck' : ' decks') + ' instead of 8', value: de });
    if (rules.hitSoft17) parts.push({ label: 'Dealer hits soft 17', value: 0.22 });
    if (!rules.doubleAfterSplit) parts.push({ label: 'No double after split', value: 0.14 });
    if (rules.surrender) parts.push({ label: 'Late surrender allowed', value: rules.hitSoft17 ? -0.09 : -0.07 });
    if (rules.resplitAces) parts.push({ label: 'Re-split aces allowed', value: -0.07 });
    // Published values for the split limit vary. This game's simulator measured
    // +0.056% ± 0.05 for 2 hands only (40 million hands each, 5 decks).
    if (rules.maxHands < 4) parts.push({ label: 'Split to ' + rules.maxHands + ' hands only', value: rules.maxHands === 2 ? 0.06 : 0.02 });
    if (Math.abs(rules.blackjackPays - 1.2) < 1e-9) parts.push({ label: 'Blackjack pays 6:5', value: 1.39 });
    else if (Math.abs(rules.blackjackPays - 1) < 1e-9) parts.push({ label: 'Blackjack pays 1:1', value: 2.27 });
    const total = parts.reduce((s, p) => s + p.value, 0);
    return { total, parts };
  }

  // ---------------------------------------------------------------------------
  // Basic strategy
  // ---------------------------------------------------------------------------

  // Basic strategy for a multi-deck shoe.
  // up: dealer up card value (1 = ace). can: {double, split, surrender}.
  // Returns 'H' hit, 'S' stand, 'D' double, 'P' split, 'R' surrender.
  function basicStrategy(cards, up, rules, can) {
    const d = up === 1 ? 11 : up;
    const { total, soft } = handTotal(cards);
    const h17 = rules.hitSoft17;
    const das = rules.doubleAfterSplit;
    const pair = cards.length === 2 && cards[0].value === cards[1].value;
    const pv = pair ? cards[0].value : 0;

    if (can.surrender) {
      if (pair && pv === 8) {
        if (h17 && d === 11) return 'R';
      } else if (!soft) {
        if (total === 16 && d >= 9) return 'R';
        if (total === 15 && (d === 10 || (h17 && d === 11))) return 'R';
        if (total === 17 && h17 && d === 11) return 'R';
      }
    }

    if (pair && can.split) {
      let split = false;
      switch (pv) {
        case 1: case 8: split = true; break;
        case 9: split = (d >= 2 && d <= 6) || d === 8 || d === 9; break;
        case 7: split = d <= 7; break;
        case 6: split = das ? d <= 6 : d >= 3 && d <= 6; break;
        case 4: split = das && (d === 5 || d === 6); break;
        case 2: case 3: split = das ? d <= 7 : d >= 4 && d <= 7; break;
        default: split = false;
      }
      if (split) return 'P';
    }

    let a; // action before the "can I double?" check: 'D' (else hit) or 'Ds' (else stand)
    if (soft) {
      if (total <= 12) a = 'H';
      else if (total <= 14) a = d === 5 || d === 6 ? 'D' : 'H';
      else if (total <= 16) a = d >= 4 && d <= 6 ? 'D' : 'H';
      else if (total === 17) a = d >= 3 && d <= 6 ? 'D' : 'H';
      else if (total === 18) {
        if (d >= 3 && d <= 6) a = 'Ds';
        else if (d === 2) a = h17 ? 'Ds' : 'S';
        else if (d === 7 || d === 8) a = 'S';
        else a = 'H';
      } else if (total === 19) a = h17 && d === 6 ? 'Ds' : 'S';
      else a = 'S';
    } else {
      if (total <= 8) a = 'H';
      else if (total === 9) a = d >= 3 && d <= 6 ? 'D' : 'H';
      else if (total === 10) a = d <= 9 ? 'D' : 'H';
      else if (total === 11) a = d <= 10 || h17 ? 'D' : 'H';
      else if (total === 12) a = d >= 4 && d <= 6 ? 'S' : 'H';
      else if (total <= 16) a = d <= 6 ? 'S' : 'H';
      else a = 'S';
    }

    if (a === 'D') return can.double ? 'D' : 'H';
    if (a === 'Ds') return can.double ? 'D' : 'S';
    return a;
  }

  const ACTION_NAMES = { H: 'Hit', S: 'Stand', D: 'Double', P: 'Split', R: 'Surrender' };

  // Short reason text for the coach.
  function strategyReason(cards, up, action) {
    const { total, soft } = handTotal(cards);
    const upName = up === 1 ? 'an Ace' : up === 10 ? 'a 10' : 'a ' + up;
    const weak = up >= 2 && up <= 6;
    switch (action) {
      case 'R':
        return 'Hard ' + total + ' against ' + upName + ' loses more than half the time. Surrender gets back half of your bet, which costs less on average.';
      case 'P':
        if (cards[0].value === 1) return 'Always split aces. Each ace starts a new hand with a good chance to make 21.';
        if (cards[0].value === 8) return 'Always split 8s. 16 is the worst total, but each 8 starts a fair hand.';
        return 'This pair does better as two hands against ' + upName + '.';
      case 'D':
        if (soft) return 'Soft ' + total + ' cannot bust with one card, and the dealer\'s ' + upName + ' busts often. Put more money on the table when you have the edge.';
        return total + ' against ' + upName + ' is a strong start. One more card often makes 19-21, so doubling pays more on average.';
      case 'S':
        if (soft && total >= 18) return 'Soft ' + total + ' already beats most dealer results. A hit cannot bust it, but it makes the hand worse more often than better.';
        if (total >= 17) return total + ' is strong enough. A hit busts too often.';
        if (weak) return 'The dealer shows ' + upName + ', a weak card, and must hit to 17. Let the dealer take the risk of a bust.';
        return 'Standing has the best average result here.';
      case 'H':
        if (total <= 11) return 'You cannot bust with one card. Hit to improve.';
        if (soft) return 'A soft hand cannot bust with one card. Hit to improve.';
        if (weak) return 'The dealer\'s ' + upName + ' busts less often than a 4, 5 or 6. Only a 10-value card busts your ' + total + ', so a hit wins a little more often.';
        return 'The dealer shows ' + upName + ', a strong card. ' + total + ' will probably lose if you stand, so take the bust risk.';
      default:
        return '';
    }
  }

  // ---------------------------------------------------------------------------
  // Odds math
  // ---------------------------------------------------------------------------

  // Dealer final result probabilities: [17, 18, 19, 20, 21, bust].
  // comp: unseen card counts (index 1..10), including the dealer's hole card.
  // If the dealer peeked (up card A or 10) and has no blackjack, the hole card
  // cannot complete a blackjack, so we remove that case.
  function dealerOutcomes(up, compIn, rules, peeked) {
    const comp = compIn.slice();
    let n = 0;
    for (let r = 1; r <= 10; r++) n += comp[r];
    const memo = new Map();

    function rec(hard, hasAce, first) {
      const total = hasAce && hard + 10 <= 21 ? hard + 10 : hard;
      const soft = hasAce && hard + 10 <= 21;
      if (total > 21) return [0, 0, 0, 0, 0, 1];
      if (!first && (total > 17 || (total === 17 && !(soft && rules.hitSoft17)))) {
        const out = [0, 0, 0, 0, 0, 0];
        out[total - 17] = 1;
        return out;
      }
      const key = hard + '|' + (hasAce ? 1 : 0) + '|' + (first ? 1 : 0) + '|' + comp.join(',');
      const hit = memo.get(key);
      if (hit) return hit;
      const out = [0, 0, 0, 0, 0, 0];
      let denom = n;
      let skip = 0;
      if (first && peeked) {
        if (up === 1) skip = 10;
        else if (up === 10) skip = 1;
        if (skip) denom -= comp[skip];
      }
      if (denom <= 0) return [0, 0, 0, 0, 0, 1];
      for (let r = 1; r <= 10; r++) {
        if (r === skip || comp[r] === 0) continue;
        const p = comp[r] / denom;
        comp[r]--; n--;
        const sub = rec(hard + r, hasAce || r === 1, false);
        comp[r]++; n++;
        for (let k = 0; k < 6; k++) out[k] += p * sub[k];
      }
      memo.set(key, out);
      return out;
    }

    return rec(up, up === 1, true);
  }

  // Win / push / lose and expected value (EV) for standing on a total.
  function standResult(total, dealer) {
    if (total > 21) return { ev: -1, win: 0, push: 0, lose: 1 };
    let win = dealer[5];
    let push = 0;
    let lose = 0;
    for (let k = 0; k < 5; k++) {
      const dt = 17 + k;
      if (dt < total) win += dealer[k];
      else if (dt === total) push += dealer[k];
      else lose += dealer[k];
    }
    return { ev: win - lose, win, push, lose };
  }

  // Expected value of every action for a player hand.
  // EV is in units of the first bet: +0.10 means you win 10% of your bet on average.
  // To keep the math fast, player draws use the same card mix (a small, standard approximation).
  function actionOdds(cards, up, compIn, rules, can, peeked) {
    const comp = compIn.slice();
    let n = 0;
    for (let r = 1; r <= 10; r++) n += comp[r];
    const q = comp.map((c) => (n > 0 ? c / n : 0));
    const dealer = dealerOutcomes(up, comp, rules, peeked);

    const bestMemo = new Map();
    function best(hard, hasAce) {
      if (hard > 21) return -1;
      const key = hard * 2 + (hasAce ? 1 : 0);
      if (bestMemo.has(key)) return bestMemo.get(key);
      const total = hasAce && hard + 10 <= 21 ? hard + 10 : hard;
      let v = standResult(total, dealer).ev;
      if (total < 21) v = Math.max(v, hitEv(hard, hasAce));
      bestMemo.set(key, v);
      return v;
    }
    function hitEv(hard, hasAce) {
      let ev = 0;
      for (let r = 1; r <= 10; r++) if (q[r] > 0) ev += q[r] * best(hard + r, hasAce || r === 1);
      return ev;
    }
    function totalOf(hard, hasAce) {
      return hasAce && hard + 10 <= 21 ? hard + 10 : hard;
    }
    function doubleEv(hard, hasAce) {
      let ev = 0;
      for (let r = 1; r <= 10; r++) if (q[r] > 0) ev += q[r] * standResult(totalOf(hard + r, hasAce || r === 1), dealer).ev;
      return 2 * ev;
    }

    let hard = 0;
    let hasAce = false;
    for (const c of cards) { hard += c.value; if (c.value === 1) hasAce = true; }
    const total = totalOf(hard, hasAce);

    let bust = 0;
    for (let r = 1; r <= 10; r++) if (hard + r > 21) bust += q[r];

    const out = {
      dealer,
      stand: standResult(total, dealer),
      hit: { ev: total >= 21 ? -1 : hitEv(hard, hasAce), bust },
    };
    if (can.double) out.double = { ev: doubleEv(hard, hasAce) };
    if (can.surrender) out.surrender = { ev: -0.5 };
    if (can.split) {
      const v = cards[0].value;
      let one = 0;
      for (let r = 1; r <= 10; r++) {
        if (q[r] === 0) continue;
        const h = v + r;
        const a = v === 1 || r === 1;
        let ev;
        if (v === 1) ev = standResult(totalOf(h, a), dealer).ev; // split aces get one card
        else {
          ev = best(h, a);
          if (rules.doubleAfterSplit) ev = Math.max(ev, doubleEv(h, a));
        }
        one += q[r] * ev;
      }
      out.split = { ev: 2 * one };
    }
    // Insurance: pays 2:1 when the hole card is a ten.
    if (up === 1) {
      const pTen = n > 0 ? comp[10] / n : 0;
      out.insurance = { pTen, ev: 3 * pTen - 1 };
    }
    return out;
  }

  // Chance that hitting a hard total busts, with a fresh shoe.
  function bustChanceFresh(hardTotal, decks) {
    const comp = new Array(11).fill(0);
    for (let r = 1; r <= 9; r++) comp[r] = 4 * decks;
    comp[10] = 16 * decks;
    const n = 52 * decks;
    let bust = 0;
    for (let r = 1; r <= 10; r++) if (hardTotal + r > 21) bust += comp[r] / n;
    return bust;
  }

  function freshComposition(decks) {
    const comp = new Array(11).fill(0);
    for (let r = 1; r <= 9; r++) comp[r] = 4 * decks;
    comp[10] = 16 * decks;
    return comp;
  }

  // Dealer final result probabilities for each up card (A..10), with a fresh shoe.
  // With peek = false these include the dealer blackjacks (no peek has happened yet).
  function dealerTable(rules) {
    const rows = [];
    for (const up of [2, 3, 4, 5, 6, 7, 8, 9, 10, 1]) {
      const comp = freshComposition(rules.decks);
      comp[up]--;
      rows.push({ up, dist: dealerOutcomes(up, comp, rules, true) });
    }
    return rows;
  }

  // Rough player edge from the Hi-Lo true count: each +1 true count moves about 0.5% to the player.
  function playerEdgeFromCount(trueCount, rules) {
    return -houseEdgeEstimate(rules).total + 0.5 * trueCount;
  }

  // ---------------------------------------------------------------------------
  // Players and bots
  // ---------------------------------------------------------------------------

  const BOT_STYLES = {
    basic: { label: 'Basic strategy', blurb: 'Plays the mathematically best move every time.' },
    mimic: { label: 'Mimic the dealer', blurb: 'Hits until 17, like the dealer. Never doubles or splits.' },
    nobust: { label: 'Never bust', blurb: 'Stands on hard 12 or more, so it never busts. Hits soft 17 or less.' },
    counter: { label: 'Card counter', blurb: 'Basic strategy plus Hi-Lo count. Bets more when the count is high.' },
  };

  const BOT_NAMES = ['Ava', 'Ben', 'Carmen', 'Dev', 'Eli', 'Fran', 'Gus', 'Hana'];

  function newStats() {
    return {
      rounds: 0, hands: 0, wins: 0, losses: 0, pushes: 0, blackjacks: 0, surrenders: 0, busts: 0,
      net: 0, initialWagered: 0, totalWagered: 0,
      decisions: 0, correct: 0, mistakes: [],
      insuranceOffers: 0, insuranceTaken: 0,
      sumUnits: 0, sumSq: 0, peakBankroll: 0, lowBankroll: Infinity,
    };
  }

  function makeSeat(opts) {
    const seat = {
      name: opts.name,
      type: opts.type || 'bot',
      style: opts.style || 'basic',
      bankroll: opts.bankroll !== undefined ? opts.bankroll : 1000,
      startBankroll: opts.bankroll !== undefined ? opts.bankroll : 1000,
      baseBet: opts.baseBet || 10,
      pendingBet: 0,
      hands: [],
      insurance: 0,
      insuranceDecided: true,
      roundStart: 0,
      roundBet: 0,
      roundNet: 0,
      inRound: false,
      stats: newStats(),
    };
    seat.stats.peakBankroll = seat.bankroll;
    seat.stats.lowBankroll = seat.bankroll;
    return seat;
  }

  // Counter's bet ramp in units of the base bet.
  function counterUnits(tc) {
    const t = Math.floor(tc);
    if (t <= 1) return 1;
    if (t === 2) return 2;
    if (t === 3) return 4;
    if (t === 4) return 6;
    return 8;
  }

  // ---------------------------------------------------------------------------
  // Table: one dealer, up to 7 seats, one shoe
  // ---------------------------------------------------------------------------

  const SNAPSHOT_VERSION = 1;

  class Table {
    constructor(rules, rng) {
      this.rules = Object.assign({}, DEFAULT_RULES, rules || {});
      this.rng = rng || Math.random;
      this.shoe = new Shoe(this.rules.decks, this.rules.penetration, this.rng);
      this.seats = [];
      this.dealer = { cards: [], holeHidden: true };
      this.phase = 'betting';
      this.turn = null; // {seat, hand}
      this.peeked = false;
      this.events = [];
      this.roundNo = 0;
      this.shuffledThisRound = false;
      this.quiet = false;
    }

    emit(kind, text, extra) {
      if (this.quiet) return;
      this.events.push(Object.assign({ kind, text, round: this.roundNo }, extra || {}));
    }

    takeEvents() {
      const e = this.events;
      this.events = [];
      return e;
    }

    deal(faceUp) {
      const before = this.shoe.shuffleCount;
      const card = this.shoe.draw();
      if (this.shoe.shuffleCount !== before) {
        this.emit('shuffle', 'The shoe ran out during the hand. The dealer shuffles a fresh shoe. The count starts again at 0.');
      }
      if (faceUp) this.shoe.see(card);
      return card;
    }

    get upCard() { return this.dealer.cards[0]; }

    activeSeats() {
      return this.seats.filter((s) => s.inRound);
    }

    // Cards to keep in the shoe before a round starts: about 4 per hand, plus a margin.
    // A larger margin would shuffle before the cut card at a full table, which
    // would make the penetration setting do nothing. If a rare round still runs
    // out, draw() shuffles a fresh shoe.
    minCardsForRound() {
      return 4 * (this.seats.length + 1) + 4;
    }

    betFor(seat) {
      if (seat.type === 'human') return seat.pendingBet;
      if (seat.style === 'counter') return seat.baseBet * counterUnits(this.shoe.trueCount);
      return seat.baseBet;
    }

    startRound() {
      if (this.phase !== 'betting' && this.phase !== 'roundOver') throw new Error('Round already in progress');
      this.clearTable();
      this.roundNo++;
      this.shuffledThisRound = false;
      if (this.shoe.cutCardOut || this.shoe.remaining < this.minCardsForRound()) {
        this.shoe.shuffle();
        this.shuffledThisRound = true;
        this.emit('shuffle', 'The cut card came out. The dealer shuffles ' + this.rules.decks + ' decks and burns one card. The count resets to 0.');
      }

      for (const seat of this.seats) {
        seat.hands = [];
        seat.insurance = 0;
        seat.insuranceDecided = true;
        seat.roundNet = 0;
        seat.inRound = false;
        let bet = this.betFor(seat);
        if (seat.type === 'bot' && seat.bankroll < bet) {
          seat.bankroll += seat.startBankroll;
          this.emit('info', says(seat, 'is') + ' out of chips and buys in again for $' + seat.startBankroll + '.');
        }
        if (bet <= 0 || bet > seat.bankroll) continue;
        seat.roundStart = seat.bankroll;
        seat.roundBet = bet;
        seat.bankroll -= bet;
        seat.hands.push(newHand(bet));
        seat.inRound = true;
        seat.stats.rounds++;
        seat.stats.initialWagered += bet;
      }
      if (this.activeSeats().length === 0) {
        this.phase = 'betting';
        return false;
      }

      // Two passes: one card to each player, then the dealer, face up.
      // The second dealer card (the hole card) stays face down.
      for (let pass = 0; pass < 2; pass++) {
        for (const seat of this.activeSeats()) seat.hands[0].cards.push(this.deal(true));
        this.dealer.cards.push(this.deal(pass === 0));
      }
      this.dealer.holeHidden = true;
      this.peeked = false;

      if (this.upCard.value === 1) {
        this.phase = 'insurance';
        for (const seat of this.activeSeats()) {
          seat.insuranceDecided = false;
          seat.stats.insuranceOffers++;
        }
        this.emit('info', 'The dealer shows an Ace and offers insurance.');
        this.autoInsurance();
        this.maybeFinishInsurance();
      } else {
        this.afterInsurance();
      }
      return true;
    }

    autoInsurance() {
      for (const seat of this.activeSeats()) {
        if (seat.type !== 'bot' || seat.insuranceDecided) continue;
        const take = seat.style === 'counter' && this.shoe.trueCount >= 3;
        this.applyInsurance(seat, take);
      }
    }

    applyInsurance(seat, take) {
      seat.insuranceDecided = true;
      if (!take) return;
      const amount = seat.hands[0].bet / 2;
      if (amount > seat.bankroll) return;
      seat.bankroll -= amount;
      seat.insurance = amount;
      seat.stats.insuranceTaken++;
      seat.stats.totalWagered += amount;
      this.emit('info', says(seat, 'takes') + ' insurance for $' + fmt(amount) + '.');
    }

    decideInsurance(seatIndex, take) {
      if (this.phase !== 'insurance') return;
      const seat = this.seats[seatIndex];
      if (!seat || seat.insuranceDecided) return;
      // Insurance is a good bet only when more than 1 in 3 unseen cards is a ten (about true count +3).
      const good = this.shoe.trueCount >= 3;
      seat.stats.decisions++;
      if (take === good) seat.stats.correct++;
      else seat.stats.mistakes.push({ hand: 'Insurance', up: 'A', did: take ? 'Took insurance' : 'No insurance', should: good ? 'Take insurance' : 'No insurance' });
      this.applyInsurance(seat, take);
      this.maybeFinishInsurance();
    }

    maybeFinishInsurance() {
      if (this.activeSeats().every((s) => s.insuranceDecided)) this.afterInsurance();
    }

    afterInsurance() {
      const up = this.upCard.value;
      if (up === 1 || up === 10) {
        this.peeked = true;
        if (isNatural(this.dealer.cards)) {
          this.revealHole();
          this.emit('dealer', 'The dealer checks the hole card and has blackjack.');
          for (const seat of this.activeSeats()) {
            if (seat.insurance) {
              const pay = seat.insurance * 3;
              seat.bankroll += pay;
              this.emit('win', (seat.type === 'human' ? 'Your' : seat.name + '\'s') + ' insurance pays 2:1 ($' + fmt(seat.insurance * 2) + ').');
            }
          }
          this.settle();
          return;
        }
        this.emit('dealer', 'The dealer checks the hole card: no blackjack. Play continues.');
        for (const seat of this.activeSeats()) {
          if (seat.insurance) this.emit('lose', says(seat, 'loses') + ' the $' + fmt(seat.insurance) + ' insurance bet.');
        }
      }
      for (const seat of this.activeSeats()) {
        const h = seat.hands[0];
        if (handIsBlackjack(h)) {
          h.done = true;
          this.emit('win', says(seat, 'has') + ' blackjack!');
        }
      }
      this.phase = 'playing';
      this.turn = { seat: -1, hand: 0 };
      this.advance();
    }

    current() {
      if (this.phase !== 'playing' || !this.turn) return null;
      const seat = this.seats[this.turn.seat];
      return { seatIndex: this.turn.seat, seat, handIndex: this.turn.hand, hand: seat.hands[this.turn.hand] };
    }

    // Moves the turn to the next hand that still needs a decision.
    advance() {
      let s = this.turn.seat;
      let h = this.turn.hand;
      if (s >= 0) {
        const seat = this.seats[s];
        while (h < seat.hands.length && seat.hands[h].done) h++;
        if (h < seat.hands.length) {
          this.turn = { seat: s, hand: h };
          if (this.prepareHand()) return;
          return this.advance();
        }
      }
      for (s = s + 1; s < this.seats.length; s++) {
        const seat = this.seats[s];
        if (!seat.inRound) continue;
        for (h = 0; h < seat.hands.length; h++) {
          if (!seat.hands[h].done) {
            this.turn = { seat: s, hand: h };
            if (this.prepareHand()) return;
            return this.advance();
          }
        }
      }
      this.turn = null;
      this.phase = 'dealer';
      this.revealHole();
      this.emit('dealer', 'The dealer turns over the hole card: ' + cardName(this.dealer.cards[1]) + '. Dealer has ' + describeHand(this.dealer.cards) + '.');
    }

    // A split hand gets its second card when its turn starts. Returns false if
    // the hand finished at once (for example, 21).
    prepareHand() {
      const { hand } = this.current();
      if (hand.cards.length === 1) {
        hand.cards.push(this.deal(true));
        // Split aces get one card. They play on only to split again, and only
        // when the rules, the hand limit and the bankroll allow it.
        if (hand.splitAces && !this.available().split) hand.done = true;
      }
      if (handTotal(hand.cards).total >= 21) hand.done = true;
      return !hand.done;
    }

    canResplitAces(hand) {
      return this.rules.resplitAces && hand.cards.length === 2 && hand.cards[0].value === 1 && hand.cards[1].value === 1;
    }

    available() {
      const cur = this.current();
      if (!cur) return {};
      const { seat, hand } = cur;
      const two = hand.cards.length === 2;
      const canAfford = seat.bankroll >= hand.bet;
      const isPair = two && hand.cards[0].value === hand.cards[1].value;
      const splitOk = isPair && canAfford && seat.hands.length < this.rules.maxHands &&
        (!hand.splitAces || this.canResplitAces(hand));
      if (hand.splitAces) return { hit: false, stand: true, double: false, split: splitOk, surrender: false };
      return {
        hit: true,
        stand: true,
        double: two && canAfford && (!hand.fromSplit || this.rules.doubleAfterSplit),
        split: splitOk,
        surrender: this.rules.surrender && two && !hand.fromSplit && seat.hands.length === 1,
      };
    }

    recommend() {
      const cur = this.current();
      if (!cur) return null;
      return this.strategyFor(cur.hand);
    }

    // Basic strategy limited to the moves that are allowed now.
    strategyFor(hand) {
      const a = this.available();
      const rec = basicStrategy(hand.cards, this.upCard.value, this.rules, a);
      const allowed = { H: a.hit, S: a.stand, D: a.double, P: a.split, R: a.surrender };
      return allowed[rec] ? rec : 'S';
    }

    // Unseen cards from the player's point of view: the shoe plus the dealer's hole card.
    unseenComposition() {
      const comp = this.shoe.composition();
      if (this.dealer.holeHidden && this.dealer.cards[1]) comp[this.dealer.cards[1].value]++;
      return comp;
    }

    odds() {
      const cur = this.current();
      if (!cur) return null;
      const a = this.available();
      return actionOdds(cur.hand.cards, this.upCard.value, this.unseenComposition(), this.rules, a, this.peeked);
    }

    act(action) {
      const cur = this.current();
      if (!cur) throw new Error('No hand to play');
      const { seat, hand } = cur;
      const a = this.available();
      const allowed = { H: a.hit, S: a.stand, D: a.double, P: a.split, R: a.surrender };
      if (!allowed[action]) throw new Error('Action not allowed: ' + action);

      const rec = this.strategyFor(hand);
      const handText = describeHand(hand.cards);
      seat.stats.decisions++;
      if (rec === action) seat.stats.correct++;
      else if (seat.type === 'human') {
        seat.stats.mistakes.push({ hand: cardsText(hand.cards) + ' (' + handText + ')', up: cardName(this.upCard), did: ACTION_NAMES[action], should: ACTION_NAMES[rec] });
        if (seat.stats.mistakes.length > 50) seat.stats.mistakes.shift();
      }
      const feedback = { action, recommended: rec, correct: rec === action, handText, cards: hand.cards.slice(), up: this.upCard.value };

      switch (action) {
        case 'H': {
          const c = this.deal(true);
          hand.cards.push(c);
          this.emit('action', says(seat, 'hits') + ' and ' + (seat.type === 'human' ? 'get ' : 'gets ') + cardName(c) + ' (' + describeHand(hand.cards) + ').', { seat: cur.seatIndex });
          const t = handTotal(hand.cards).total;
          if (t > 21) {
            hand.done = true;
            this.emit('lose', says(seat, 'busts') + '.', { seat: cur.seatIndex });
          } else if (t === 21) hand.done = true;
          break;
        }
        case 'S':
          hand.done = true;
          this.emit('action', says(seat, 'stands') + ' on ' + describeHand(hand.cards) + '.', { seat: cur.seatIndex });
          break;
        case 'D': {
          seat.bankroll -= hand.bet;
          hand.bet *= 2;
          hand.doubled = true;
          const c = this.deal(true);
          hand.cards.push(c);
          hand.done = true;
          this.emit('action', says(seat, 'doubles') + ' and ' + (seat.type === 'human' ? 'get ' : 'gets ') + cardName(c) + ' (' + describeHand(hand.cards) + ').', { seat: cur.seatIndex });
          break;
        }
        case 'P': {
          seat.bankroll -= hand.bet;
          const second = newHand(hand.bet);
          second.cards.push(hand.cards.pop());
          second.fromSplit = true;
          hand.fromSplit = true;
          if (second.cards[0].value === 1) {
            hand.splitAces = true;
            second.splitAces = true;
          }
          seat.hands.splice(cur.handIndex + 1, 0, second);
          this.emit('action', says(seat, 'splits') + ' ' + cardName(second.cards[0]) + 's.', { seat: cur.seatIndex });
          break;
        }
        case 'R':
          hand.surrendered = true;
          hand.done = true;
          seat.bankroll += hand.bet / 2;
          this.emit('action', says(seat, 'surrenders') + ' and ' + (seat.type === 'human' ? 'get' : 'gets') + ' back half the bet.', { seat: cur.seatIndex });
          break;
      }
      this.advance();
      return feedback;
    }

    botAction() {
      const cur = this.current();
      const { seat, hand } = cur;
      const { total, soft } = handTotal(hand.cards);
      switch (seat.style) {
        case 'mimic':
          if (hand.splitAces) return 'S';
          return total < 17 || (total === 17 && soft && this.rules.hitSoft17) ? 'H' : 'S';
        case 'nobust': {
          if (hand.splitAces) return 'S';
          // Hits hard 11 or less and soft 17 or less: hands that one card cannot bust.
          return total <= 11 || (soft && total <= 17) ? 'H' : 'S';
        }
        default:
          return this.strategyFor(hand);
      }
    }

    // Plays one move for a bot. Returns true if a bot moved.
    botStep() {
      const cur = this.current();
      if (!cur || cur.seat.type !== 'bot') return false;
      let action = this.botAction();
      const a = this.available();
      const allowed = { H: a.hit, S: a.stand, D: a.double, P: a.split, R: a.surrender };
      if (!allowed[action]) action = 'S';
      this.act(action);
      return true;
    }

    revealHole() {
      if (this.dealer.holeHidden && this.dealer.cards[1]) {
        this.dealer.holeHidden = false;
        this.shoe.see(this.dealer.cards[1]);
      }
    }

    dealerMustPlay() {
      return this.activeSeats().some((s) => s.hands.some((h) => !h.surrendered && !handIsBust(h) && !handIsBlackjack(h)));
    }

    dealerShouldHit() {
      const { total, soft } = handTotal(this.dealer.cards);
      return total < 17 || (total === 17 && soft && this.rules.hitSoft17);
    }

    // Dealer draws one card if the rules say so. Returns true if a card was drawn.
    dealerStep() {
      if (this.phase !== 'dealer') return false;
      if (this.dealerMustPlay() && this.dealerShouldHit()) {
        const c = this.deal(true);
        this.dealer.cards.push(c);
        this.emit('dealer', 'Dealer draws ' + cardName(c) + ' (' + describeHand(this.dealer.cards) + ').');
        return true;
      }
      const t = handTotal(this.dealer.cards).total;
      if (this.dealerMustPlay()) {
        this.emit('dealer', t > 21 ? 'Dealer busts with ' + t + '!' : 'Dealer stands on ' + describeHand(this.dealer.cards) + '.');
      }
      this.settle();
      return false;
    }

    settle() {
      const dealerTotal = handTotal(this.dealer.cards).total;
      const dealerBJ = isNatural(this.dealer.cards);
      const dealerBust = dealerTotal > 21;
      for (const seat of this.activeSeats()) {
        for (const hand of seat.hands) {
          const st = seat.stats;
          st.hands++;
          st.totalWagered += hand.bet;
          const t = handTotal(hand.cards).total;
          let payout = 0; // money returned to the bankroll, including the bet
          if (hand.surrendered) {
            hand.result = 'surrender';
            hand.net = -hand.bet / 2;
            st.surrenders++;
            st.losses++;
          } else if (handIsBlackjack(hand)) {
            if (dealerBJ) { hand.result = 'push'; payout = hand.bet; st.pushes++; }
            else { hand.result = 'blackjack'; payout = hand.bet * (1 + this.rules.blackjackPays); st.wins++; st.blackjacks++; }
          } else if (t > 21) {
            hand.result = 'bust'; st.losses++; st.busts++;
          } else if (dealerBJ) {
            hand.result = 'lose'; st.losses++;
          } else if (dealerBust || t > dealerTotal) {
            hand.result = 'win'; payout = hand.bet * 2; st.wins++;
          } else if (t === dealerTotal) {
            hand.result = 'push'; payout = hand.bet; st.pushes++;
          } else {
            hand.result = 'lose'; st.losses++;
          }
          if (!hand.surrendered) hand.net = payout - hand.bet;
          seat.bankroll += payout;
        }
        seat.roundNet = seat.bankroll - seat.roundStart;
        seat.stats.net += seat.roundNet;
        const units = seat.roundNet / seat.roundBet;
        seat.stats.sumUnits += units;
        seat.stats.sumSq += units * units;
        seat.stats.peakBankroll = Math.max(seat.stats.peakBankroll, seat.bankroll);
        seat.stats.lowBankroll = Math.min(seat.stats.lowBankroll, seat.bankroll);
        const r = seat.roundNet;
        this.emit(r > 0 ? 'win' : r < 0 ? 'lose' : 'push',
          (r > 0 ? says(seat, 'wins') + ' $' + fmt(r) : r < 0 ? says(seat, 'loses') + ' $' + fmt(-r) : says(seat, 'breaks') + ' even') + ' this round.', { seat: this.seats.indexOf(seat) });
      }
      this.phase = 'roundOver';
      this.turn = null;
    }

    clearTable() {
      let n = this.dealer.cards.length;
      for (const s of this.seats) for (const h of s.hands) n += h.cards.length;
      this.shoe.discards += n;
      this.dealer = { cards: [], holeHidden: true };
      for (const s of this.seats) { s.hands = []; s.inRound = false; s.insurance = 0; }
      this.phase = 'betting';
    }

    // Plain-data copy of the whole table, so a reload can resume the same hand.
    // Cards are stored once (in the shoe) and hands refer to them by id.
    snapshot() {
      const sh = this.shoe;
      const ids = (cards) => cards.map((c) => c.id);
      return {
        v: SNAPSHOT_VERSION,
        rules: this.rules,
        shoe: {
          decks: sh.decks, penetration: sh.penetration, shuffleCount: sh.shuffleCount,
          cards: sh.cards.map((c) => [c.id, c.rank, c.suit]),
          burned: sh.burned ? sh.burned.id : null,
          pos: sh.pos, cutIndex: sh.cutIndex, runningCount: sh.runningCount, discards: sh.discards,
        },
        seats: this.seats.map((seat) => Object.assign({}, seat, {
          hands: seat.hands.map((h) => Object.assign({}, h, { cards: ids(h.cards) })),
          stats: Object.assign({}, seat.stats, { lowBankroll: Number.isFinite(seat.stats.lowBankroll) ? seat.stats.lowBankroll : null }),
        })),
        dealer: { cards: ids(this.dealer.cards), holeHidden: this.dealer.holeHidden },
        // Cards on the table from before an emergency reshuffle.
        loose: this.tableCards().filter((c) => !sh.cards.includes(c)).map((c) => [c.id, c.rank, c.suit]),
        phase: this.phase,
        turn: this.turn,
        peeked: this.peeked,
        roundNo: this.roundNo,
        shuffledThisRound: this.shuffledThisRound,
      };
    }

    tableCards() {
      const all = this.dealer.cards.slice();
      for (const s of this.seats) for (const h of s.hands) all.push(...h.cards);
      return all;
    }

    static fromSnapshot(data, rng) {
      if (!data || data.v !== SNAPSHOT_VERSION) throw new Error('Unknown save format');
      const t = new Table(data.rules, rng);
      const sh = t.shoe;
      const byId = new Map();
      sh.cards = data.shoe.cards.map(([id, rank, suit]) => {
        const c = { id, rank, suit, value: rankValue(rank) };
        byId.set(id, c);
        return c;
      });
      for (const [id, rank, suit] of data.loose || []) byId.set(id, { id, rank, suit, value: rankValue(rank) });
      const card = (id) => {
        const c = byId.get(id);
        if (!c) throw new Error('Saved hand refers to a missing card');
        return c;
      };
      Object.assign(sh, {
        decks: data.shoe.decks, penetration: data.shoe.penetration, shuffleCount: data.shoe.shuffleCount,
        burned: data.shoe.burned === null ? null : card(data.shoe.burned),
        pos: data.shoe.pos, cutIndex: data.shoe.cutIndex, runningCount: data.shoe.runningCount, discards: data.shoe.discards,
      });
      t.seats = data.seats.map((s) => {
        if (s.type !== 'human' && !BOT_STYLES[s.style]) throw new Error('Unknown player style in the save');
        const seat = Object.assign({}, s, { hands: s.hands.map((h) => Object.assign({}, h, { cards: h.cards.map(card) })) });
        seat.stats = Object.assign(newStats(), s.stats);
        if (seat.stats.lowBankroll === null) seat.stats.lowBankroll = seat.bankroll;
        return seat;
      });
      t.dealer = { cards: data.dealer.cards.map(card), holeHidden: data.dealer.holeHidden };
      t.phase = data.phase;
      t.turn = data.turn;
      t.peeked = data.peeked;
      t.roundNo = data.roundNo;
      t.shuffledThisRound = data.shuffledThisRound;
      return t;
    }

    // Plays a whole round at once. Only for tables where every seat is a bot.
    playRoundInstant() {
      if (!this.startRound()) return false;
      if (this.phase === 'insurance') { this.autoInsurance(); this.maybeFinishInsurance(); }
      while (this.phase === 'playing') this.botStep();
      while (this.phase === 'dealer') this.dealerStep();
      return true;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // "Ava hits" but "You hit".
  const YOU_VERBS = {
    is: 'are', has: 'have', takes: 'take', loses: 'lose', wins: 'win', hits: 'hit', busts: 'bust', stands: 'stand',
    doubles: 'double', splits: 'split', surrenders: 'surrender', breaks: 'break',
  };
  function says(seat, verb) {
    return seat.type === 'human' ? 'You ' + (YOU_VERBS[verb] || verb) : seat.name + ' ' + verb;
  }

  function fmt(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  }

  function cardName(c) {
    return c.rank + c.suit;
  }

  function cardsText(cards) {
    return cards.map(cardName).join(' ');
  }

  // Runs many hands fast for one strategy. Call run() again to add more hands.
  class Simulator {
    constructor(rules, style, seed) {
      this.table = new Table(rules, seed !== undefined ? mulberry32(seed) : Math.random);
      this.table.quiet = true;
      this.seat = makeSeat({ name: 'Sim', type: 'bot', style, bankroll: 1e12, baseBet: 1 });
      this.table.seats.push(this.seat);
    }

    run(rounds) {
      for (let i = 0; i < rounds; i++) this.table.playRoundInstant();
      return this.result();
    }

    result() {
      const s = this.seat.stats;
      const n = s.rounds;
      const edge = n ? -s.net / s.initialWagered : 0;
      // Spread of the result per round, in units of that round's first bet.
      const mean = n ? s.sumUnits / n : 0;
      const variance = n > 1 ? (s.sumSq - n * mean * mean) / (n - 1) : 0;
      const se = n > 1 ? Math.sqrt(variance / n) : 0;
      return { rounds: n, net: s.net, initialWagered: s.initialWagered, edge, se, sd: Math.sqrt(Math.max(variance, 0)), stats: s };
    }
  }

  // ---------------------------------------------------------------------------
  // Practice drill
  // ---------------------------------------------------------------------------

  const DRILL_FOCUS = {
    all: { label: 'All hands', blurb: 'Hard totals, soft totals and pairs, with every move allowed.' },
    hitstand: { label: 'Hit or stand', blurb: 'Only Hit and Stand. Mostly hard 12–16 and soft 17–18, the hands that people get wrong most.' },
    soft: { label: 'Soft hands', blurb: 'An Ace with one other card.' },
    pairs: { label: 'Pairs', blurb: 'Split or not?' },
  };

  // Makes one practice spot: two player cards and a dealer up card.
  // Returns {cards, up, kind, can}. "can" lists the moves the drill allows.
  function drillHand(focus, rules, rng) {
    const rand = rng || Math.random;
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const mk = (rank) => ({ rank, suit: pick(SUITS), value: rankValue(rank) });
    const tenRank = () => pick(['10', 'J', 'Q', 'K']);
    const rankOf = (v) => (v === 1 ? 'A' : v === 10 ? tenRank() : String(v));
    const hardCards = (t) => {
      const opts = [];
      for (let a = 2; a <= 10; a++) {
        const b = t - a;
        if (b >= 2 && b <= 10 && b !== a && a < b) opts.push([a, b]);
      }
      const [a, b] = pick(opts);
      return rand() < 0.5 ? [mk(rankOf(a)), mk(rankOf(b))] : [mk(rankOf(b)), mk(rankOf(a))];
    };

    let kind = focus;
    if (focus === 'all') {
      const r = rand();
      kind = r < 0.6 ? 'hard' : r < 0.8 ? 'soft' : 'pairs';
    }
    let cards;
    if (kind === 'hitstand') {
      const r = rand();
      if (r < 0.7) cards = hardCards(12 + Math.floor(rand() * 5));
      else if (r < 0.9) cards = [mk('A'), mk(pick(['6', '7']))];
      else cards = hardCards(pick([8, 9, 10, 11, 17, 18, 19]));
    } else if (kind === 'hard') {
      cards = hardCards(5 + Math.floor(rand() * 15));
    } else if (kind === 'soft') {
      cards = [mk('A'), mk(String(2 + Math.floor(rand() * 8)))];
      if (rand() < 0.5) cards.reverse();
    } else {
      const v = 1 + Math.floor(rand() * 10);
      cards = [mk(rankOf(v)), mk(rankOf(v))];
    }
    const up = 1 + Math.floor(rand() * 10);
    const pair = cards[0].value === cards[1].value;
    const can = kind === 'hitstand'
      ? { double: false, split: false, surrender: false }
      : { double: true, split: pair, surrender: !!rules.surrender };
    return { cards, up, upCard: mk(rankOf(up)), kind: kind === 'hitstand' ? 'hard' : kind, can };
  }

  const BJ = {
    RANKS, SUITS, Shoe, Table, Simulator, DEFAULT_RULES, BOT_STYLES, BOT_NAMES, ACTION_NAMES,
    rankValue, hiLo, handTotal, isNatural, describeHand, basicStrategy, strategyReason,
    dealerOutcomes, actionOdds, standResult, dealerTable, bustChanceFresh, freshComposition,
    houseEdgeEstimate, playerEdgeFromCount, counterUnits, DRILL_FOCUS, drillHand, makeSeat, newStats, mulberry32, cardName, fmt,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BJ;
  else root.BJ = BJ;
})(typeof window !== 'undefined' ? window : globalThis);
