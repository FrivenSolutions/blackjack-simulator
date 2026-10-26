// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const BJ = require('../js/engine.js');

const R = BJ.DEFAULT_RULES;
const card = (rank) => ({ rank, suit: '♠', value: BJ.rankValue(rank) });
const cards = (...ranks) => ranks.map(card);
const ALL = { double: true, split: true, surrender: true };

// Builds a table whose shoe deals the given ranks in order (after the burn card).
function riggedTable(ranks, rules, seats) {
  const t = new BJ.Table(rules);
  t.shoe.cards = [card('2')].concat(ranks.map(card), Array(300).fill(0).map(() => card('5'))).map((c, i) => Object.assign(c, { id: i }));
  t.shoe.pos = 1;
  t.shoe.cutIndex = 1000;
  for (const s of seats) t.seats.push(BJ.makeSeat(s));
  return t;
}

test('hand totals count an ace as 11 when it can', () => {
  assert.deepStrictEqual(BJ.handTotal(cards('A', '6')), { total: 17, soft: true });
  assert.deepStrictEqual(BJ.handTotal(cards('A', '6', '10')), { total: 17, soft: false });
  assert.deepStrictEqual(BJ.handTotal(cards('A', 'A', '9')), { total: 21, soft: true });
  assert.ok(BJ.isNatural(cards('A', 'K')));
  assert.ok(!BJ.isNatural(cards('7', '7', '7')));
});

test('a 5-deck shoe has 260 cards and the Hi-Lo count of a full shoe is 0', () => {
  const shoe = new BJ.Shoe(5, 0.75, BJ.mulberry32(1));
  assert.strictEqual(shoe.total, 260);
  assert.strictEqual(shoe.cutIndex, 195);
  shoe.see(shoe.burned);
  while (shoe.remaining > 0) shoe.see(shoe.draw());
  assert.strictEqual(shoe.runningCount, 0);
});

test('basic strategy matches the standard chart', () => {
  const bs = (r, up, rules = R, can = ALL) => BJ.basicStrategy(cards(...r), up, rules, can);
  assert.strictEqual(bs(['10', '6'], 10), 'R');
  assert.strictEqual(bs(['10', '6'], 10, R, { double: true, split: true, surrender: false }), 'H');
  assert.strictEqual(bs(['10', '2'], 3), 'H');
  assert.strictEqual(bs(['10', '2'], 4), 'S');
  assert.strictEqual(bs(['6', '5'], 1), 'H');
  assert.strictEqual(bs(['6', '5'], 1, Object.assign({}, R, { hitSoft17: true })), 'D');
  assert.strictEqual(bs(['A', '7'], 2), 'S');
  assert.strictEqual(bs(['A', '7'], 9), 'H');
  assert.strictEqual(bs(['A', '7'], 5), 'D');
  assert.strictEqual(bs(['A', '7', '2'].slice(0, 2), 4), 'D');
  assert.strictEqual(BJ.basicStrategy(cards('A', '2', '5'), 4, R, { double: false }), 'S');
  assert.strictEqual(bs(['8', '8'], 10), 'P');
  assert.strictEqual(bs(['9', '9'], 7), 'S');
  assert.strictEqual(bs(['10', '10'], 6), 'S');
  assert.strictEqual(bs(['5', '5'], 9), 'D');
  assert.strictEqual(bs(['4', '4'], 5), 'P');
  assert.strictEqual(bs(['4', '4'], 5, Object.assign({}, R, { doubleAfterSplit: false })), 'H');
});

test('dealer outcome probabilities add up to 1 and match known bust rates', () => {
  const comp = BJ.freshComposition(5);
  comp[6]--;
  const d6 = BJ.dealerOutcomes(6, comp, R, false);
  assert.ok(Math.abs(d6.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(d6[5] > 0.41 && d6[5] < 0.43, 'dealer 6 busts about 42%: ' + d6[5]);
  const comp10 = BJ.freshComposition(5);
  comp10[10]--;
  const d10 = BJ.dealerOutcomes(10, comp10, R, true);
  assert.ok(d10[5] > 0.22 && d10[5] < 0.24, 'dealer 10 busts about 23%: ' + d10[5]);
});

test('action odds agree with basic strategy on clear cases', () => {
  const comp = BJ.freshComposition(5);
  const o = BJ.actionOdds(cards('10', '10'), 6, comp, R, ALL, false);
  assert.ok(o.stand.ev > 0.6);
  assert.ok(o.stand.ev > o.hit.ev && o.stand.ev > o.double.ev);
  const o11 = BJ.actionOdds(cards('6', '5'), 6, comp, R, ALL, false);
  assert.ok(o11.double.ev > o11.hit.ev);
  const o16 = BJ.actionOdds(cards('10', '6'), 10, comp, R, ALL, true);
  // 16 vs 10 is a famous close call: hit and stand are almost equal, surrender beats both.
  assert.ok(o16.surrender.ev > o16.hit.ev && o16.surrender.ev > o16.stand.ev);
  assert.ok(Math.abs(o16.hit.ev - o16.stand.ev) < 0.02);
  // Any 6, 7, 8, 9 or ten-value card busts 16: 160 of 260 cards.
  assert.ok(Math.abs(o16.hit.bust - 160 / 260) < 1e-9);
  const oA = BJ.actionOdds(cards('9', '7'), 1, comp, R, ALL, false);
  assert.ok(oA.insurance.ev < 0, 'insurance is a bad bet off the top');
});

test('a player blackjack pays 3:2', () => {
  const t = riggedTable(['A', '9', 'K', '7'], R, [{ name: 'You', type: 'human' }]);
  t.seats[0].pendingBet = 10;
  t.startRound();
  assert.strictEqual(t.phase, 'dealer');
  while (t.phase === 'dealer') t.dealerStep();
  assert.strictEqual(t.seats[0].hands[0].result, 'blackjack');
  assert.strictEqual(t.seats[0].bankroll, 1015);
});

test('dealer peeks for blackjack and pays insurance 2:1', () => {
  // Player 10,9; dealer A up, K in the hole.
  const t = riggedTable(['10', 'A', '9', 'K'], R, [{ name: 'You', type: 'human' }]);
  t.seats[0].pendingBet = 10;
  t.startRound();
  assert.strictEqual(t.phase, 'insurance');
  t.decideInsurance(0, true);
  assert.strictEqual(t.phase, 'roundOver');
  // Lose 10 on the hand, win 10 on the 5 insurance bet: even.
  assert.strictEqual(t.seats[0].bankroll, 1000);
});

test('splitting, doubling and settling work across hands', () => {
  // Player 8,8 vs dealer 6 up, 10 hole. Split hands get 3 (then double, gets 10) and 10.
  // Dealer 16 draws 10 and busts.
  const t = riggedTable(['8', '6', '8', '10', '3', '10', '10', '10'], R, [{ name: 'You', type: 'human' }]);
  t.seats[0].pendingBet = 10;
  t.startRound();
  t.act('P');
  assert.strictEqual(t.seats[0].hands.length, 2);
  assert.deepStrictEqual(t.current().hand.cards.map((c) => c.rank), ['8', '3']);
  t.act('D');
  assert.deepStrictEqual(t.current().hand.cards.map((c) => c.rank), ['8', '10']);
  t.act('S');
  while (t.phase === 'dealer') t.dealerStep();
  assert.strictEqual(BJ.handTotal(t.dealer.cards).total, 26);
  assert.deepStrictEqual(t.seats[0].hands.map((h) => h.result), ['win', 'win']);
  assert.strictEqual(t.seats[0].bankroll, 1030);
});

test('surrender returns half the bet', () => {
  const t = riggedTable(['10', '10', '6', '7'], R, [{ name: 'You', type: 'human' }]);
  t.seats[0].pendingBet = 20;
  t.startRound();
  const fb = t.act('R');
  assert.ok(fb.correct);
  while (t.phase === 'dealer') t.dealerStep();
  assert.strictEqual(t.seats[0].bankroll, 990);
});

test('the shoe shuffles when the cut card comes out', () => {
  const t = new BJ.Table({ decks: 1, penetration: 0.5 }, BJ.mulberry32(3));
  t.seats.push(BJ.makeSeat({ name: 'Bot', style: 'basic' }));
  let shuffles = 0;
  for (let i = 0; i < 50; i++) {
    t.playRoundInstant();
    if (t.shuffledThisRound) shuffles++;
  }
  assert.ok(shuffles >= 8, 'shuffled ' + shuffles + ' times');
});

test('simulated basic strategy edge is near the published estimate', () => {
  const r = new BJ.Simulator(R, 'basic', 11).run(200000);
  const est = BJ.houseEdgeEstimate(R).total / 100;
  assert.ok(Math.abs(r.edge - est) < 4 * r.se + 0.002, 'edge ' + r.edge + ' vs ' + est);
});

test('drill hands match their focus', () => {
  const rng = BJ.mulberry32(9);
  for (let i = 0; i < 2000; i++) {
    for (const focus of Object.keys(BJ.DRILL_FOCUS)) {
      const d = BJ.drillHand(focus, R, rng);
      assert.strictEqual(d.cards.length, 2);
      assert.ok(d.up >= 1 && d.up <= 10);
      assert.strictEqual(d.upCard.value, d.up);
      const pair = d.cards[0].value === d.cards[1].value;
      const soft = BJ.handTotal(d.cards).soft;
      if (focus === 'pairs') assert.ok(pair);
      if (focus === 'soft') assert.ok(soft && !pair);
      if (focus === 'hitstand') {
        assert.ok(!pair);
        assert.ok(['H', 'S'].includes(BJ.basicStrategy(d.cards, d.up, R, d.can)));
      }
      if (focus === 'all' && d.kind === 'hard') assert.ok(!pair && !soft);
    }
  }
});

test('a table snapshot resumes the same hand after a JSON round trip', () => {
  const t = new BJ.Table(R, BJ.mulberry32(21));
  t.seats.push(BJ.makeSeat({ name: 'Ava', style: 'counter' }), BJ.makeSeat({ name: 'You', type: 'human' }));
  t.seats[1].pendingBet = 10;
  // Play until the human must act, then copy the table.
  let copy = null;
  for (let round = 0; round < 50 && !copy; round++) {
    t.startRound();
    if (t.phase === 'insurance') t.decideInsurance(1, false);
    while (t.phase === 'playing' && t.current().seat.type === 'bot') t.botStep();
    if (t.phase === 'playing') copy = BJ.Table.fromSnapshot(JSON.parse(JSON.stringify(t.snapshot())));
    else while (t.phase === 'dealer') t.dealerStep();
  }
  assert.ok(copy, 'reached a human decision');
  assert.strictEqual(copy.shoe.pos, t.shoe.pos);
  assert.strictEqual(copy.shoe.runningCount, t.shoe.runningCount);
  assert.deepStrictEqual(copy.current().hand.cards.map((c) => c.id), t.current().hand.cards.map((c) => c.id));
  assert.strictEqual(copy.recommend(), t.recommend());
  // Both tables must finish the hand the same way.
  for (const tb of [t, copy]) {
    tb.act(tb.recommend());
    while (tb.phase === 'playing') tb.current().seat.type === 'bot' ? tb.botStep() : tb.act(tb.recommend());
    while (tb.phase === 'dealer') tb.dealerStep();
  }
  assert.deepStrictEqual(copy.seats.map((s) => s.bankroll), t.seats.map((s) => s.bankroll));
  assert.deepStrictEqual(copy.dealer.cards.map((c) => c.id), t.dealer.cards.map((c) => c.id));
  assert.throws(() => BJ.Table.fromSnapshot({ v: 99 }));
});

test('re-split aces never asks a bot for a move it cannot make', () => {
  // Before the fix, a split ace that drew another ace at the hand limit made
  // basic strategy say "hit", which split aces may not do, and the game stopped.
  for (const maxHands of [2, 3, 4]) {
    const sim = new BJ.Simulator(Object.assign({}, R, { resplitAces: true, maxHands, decks: 1 }), 'basic', 5);
    assert.doesNotThrow(() => sim.run(40000));
  }
});

test('split aces at the hand limit stand at once', () => {
  // Player A,A vs 6. Split; each ace gets another ace. With re-split allowed
  // but a 2-hand limit, both hands must end with no further choice.
  const t = riggedTable(['A', '6', 'A', '10', 'A', 'A', '5', '5'], Object.assign({}, R, { resplitAces: true, maxHands: 2 }), [{ name: 'You', type: 'human' }]);
  t.seats[0].pendingBet = 10;
  t.startRound();
  t.act('P');
  assert.strictEqual(t.phase, 'dealer');
  assert.deepStrictEqual(t.seats[0].hands.map((h) => h.cards.map((c) => c.rank).join(',')), ['A,A', 'A,A']);
});

test('a save made after an emergency reshuffle restores the cards on the table', () => {
  const t = riggedTable(['10', '6', '7'], R, [{ name: 'You', type: 'human' }]);
  t.seats[0].pendingBet = 10;
  t.startRound();
  // Empty the shoe so the next card forces a fresh shuffle in the middle of the hand.
  t.shoe.pos = t.shoe.cards.length;
  t.act('H');
  const events = t.takeEvents().map((e) => e.kind);
  assert.ok(events.includes('shuffle'));
  const ids = t.tableCards().map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'card ids stay unique');
  const copy = BJ.Table.fromSnapshot(JSON.parse(JSON.stringify(t.snapshot())));
  assert.deepStrictEqual(copy.tableCards().map((c) => c.rank + c.suit), t.tableCards().map((c) => c.rank + c.suit));
});

test('the penetration setting works at a full table', () => {
  const t = new BJ.Table(Object.assign({}, R, { penetration: 0.85 }), BJ.mulberry32(8));
  for (let i = 0; i < 7; i++) t.seats.push(BJ.makeSeat({ name: 'Bot' + i }));
  const dealtAtShuffle = [];
  for (let i = 0; i < 400; i++) {
    const pos = t.shoe.pos;
    t.playRoundInstant();
    if (t.shuffledThisRound && i > 0) dealtAtShuffle.push(pos / t.shoe.total);
  }
  const avg = dealtAtShuffle.reduce((a, b) => a + b, 0) / dealtAtShuffle.length;
  assert.ok(avg > 0.83, 'shuffles near the cut card, at ' + avg.toFixed(3));
});
