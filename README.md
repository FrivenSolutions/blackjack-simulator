# Shoe & Odds: a blackjack simulator that teaches the odds

Shoe & Odds is a casino blackjack game for the web browser. It plays like a real
table, and it shows you the math behind every hand.

## Run it

Open `index.html` in a web browser. You do not need to install or build anything.

## The game

On a phone, the table fits on one screen. Large buttons sit in a dock at the
bottom. A short strip above them shows the key odds. Tap it to open the full
odds, coach, count and log.


- One shoe holds 5 decks (you can choose 1 to 8). The dealer burns one card after
  each shuffle. When the cut card comes out (75% of the shoe by default), the
  dealer finishes the hand and shuffles.
- You can add 0 to 6 computer players. They take cards from the same shoe.
  Each one has a style:
  - **Basic strategy**: plays the best move every time.
  - **Mimic the dealer**: hits until 17, never doubles or splits.
  - **Never bust**: stands on hard 12 or more.
  - **Card counter**: basic strategy, and it bets more when the Hi-Lo count is high.
- You can hit, stand, double, split (up to 4 hands), surrender, and take
  insurance or even money. The dealer checks for blackjack with a 10 or an Ace up.
- Default rules: dealer stands on soft 17, blackjack pays 3 to 2, double after
  split, late surrender. You can change all of them in **Settings**.
- Keyboard: `H` hit, `S` stand, `D` double, `P` split, `R` surrender,
  `I` / `N` insurance, `Enter` deal.

## The teaching tools

- **Live odds**: the expected value (average win or loss per $1) of each move,
  the chance to bust, and the dealer's chances. The math uses the exact cards left
  in the shoe.
- **Strategy coach**: shows the basic strategy move, explains it, and tells you
  what a mistake costs.
- **Card counting trainer**: running count, true count and your edge. You can
  hide the count and test yourself.
- **Drill**: flash-card practice with no money. The game shows a hand and a dealer
  up card, you pick a move, and it tells you at once if you are right, why, and
  the EV of each move. Choose all hands, hit or stand only, soft hands, or pairs.
  A hand that you get wrong comes back a few hands later.
- **Learn**: a "Hit or stand?" lesson (the rules in short, the three groups of
  hands, a hit/stand chart for hard 12–16, soft hands, and 16 against a 10),
  house edge for your rules, dealer outcomes by up card, a basic
  strategy chart for your rules, card counting, insurance, and a glossary.
- **Simulator**: plays up to 1,000,000 hands per strategy in a few seconds and
  measures the house edge with a 95% range.
- **Stats**: your results, your bankroll against the expected path, and the moves
  you got wrong.

## Accuracy

With the default rules, 20 million simulated hands of basic strategy give a house
edge of about 0.33%. This matches published rule tables (0.33%).

## Code

| File | Purpose |
|------|---------|
| `js/engine.js` | Shoe, rules, basic strategy, odds math, Hi-Lo count, table flow, simulator. No browser code. |
| `js/ui.js` | Screen code for the table and the other pages. |
| `css/style.css` | Styles, with light and dark themes. |
| `tests/engine.test.js` | Engine tests. Run `node --test tests/*.test.js`. |
