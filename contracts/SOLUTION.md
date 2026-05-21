# WorldCupBetting — Candidate Solution

Implementation of `contracts/WorldCupBetting.sol` for the Rather Labs smart-contract-engineer assessment.

## Quick start

```bash
cd contracts
npm install --legacy-peer-deps      # see "Dependency notes" below
npx hardhat compile
npx hardhat test                    # all 25 tests pass (11 assessment + 14 extra)
npx hardhat coverage                # WorldCupBetting.sol > 94% statements / 96% lines
```

Run the assessment suite alone:

```bash
npx hardhat test test/WorldCupBetting.assessment.test.ts
```

## Test results

```
PredictionMarket
  ✔ Should create a market
  ✔ Should place a bet and claim winnings

World Cup on-chain betting (assessment scenarios)
  ✔ Scenario A: three-outcome (1X2) match
  ✔ Scenario B: knockout YES/NO with platform fee
  ✔ Scenario C: oracle cannot resolve too early
  ✔ Scenario D: non-arbitrator cannot resolve
  ✔ Scenario E: bets locked at/after resolution time
  ✔ Scenario F: slippage guard rejects bets
  ✔ Scenario G: secondary market — buyer claims winnings
  ✔ Scenario H: ERC20 collateral lifecycle
  ✔ Scenario I: losing settle + "Already claimed"

WorldCupBetting — extra coverage (14 additional tests covering
input validation, fee math, access control, secondary-market edges, AMM math)

25 passing
```

| File | % Stmts | % Branch | % Funcs | % Lines |
|---|---|---|---|---|
| WorldCupBetting.sol | **94.44** | **73.33** | **94.74** | **96.48** |

## Design

### Architecture

`WorldCupBetting` is a single-contract prediction market that escrows collateral per market and tracks AMM-style shares per outcome. It integrates with two satellite contracts:

- `ReputationSystem` (provided) — credits winners +10 and debits losers −5 on claim
- `MockERC20` (provided) — used for ERC20 collateral path in tests

### Storage layout

```solidity
struct Market { id, question, description, outcomes[], resolutionTime,
                arbitrator, creator, createdAt, status, winningOutcome,
                collateral, totalVolume }

struct Bet { id, bettor, marketId, outcomeIndex, amount, shares,
             timestamp, claimed }

struct Listing { active, price }
```

Two-level mappings track outcome-level state without traversing arrays:

- `outcomePools[marketId][outcomeIndex] → totalCollateralForOutcome`
- `outcomeShares[marketId][outcomeIndex] → totalSharesIssued`

Fee accounting is per-collateral so ETH and each ERC20 are settled independently:

- `collectedFees[address(0)] → ETH fees`
- `collectedFees[tokenAddress] → ERC20 fees`

### AMM share-pricing formula

For a bet of `amount` on outcome `i`:

```
if outcomePool[i] == 0:
    shares = amount * 100
else:
    shares = (amount * 100 * totalPool) / ((outcomePool[i] + amount) * outcomePool[i])
```

- Early bettors and bettors backing an outcome with a smaller pool receive more shares per wei.
- The 100 multiplier keeps integer division precision high while staying under `uint256.max` for realistic stake sizes.
- Pure view function — gas-free off-chain quoting before `placeBet`.

### Payout & fee math

Winners receive a pro-rata share of the full pool minus a 2% platform fee:

```
grossPayout = bet.shares * totalPool / totalWinningShares
fee         = grossPayout * 200 / 10_000        // 2.00% in BPS
netPayout   = grossPayout − fee
```

Fee is denominated in the market's collateral; owner withdraws via `withdrawFees(collateral)`.

### Lifecycle

1. **createMarket** — anyone can open a market; arbitrator and resolution timestamp are immutable.
2. **placeBet** — open until `block.timestamp == resolutionTime`. Reverts with `"Market closed"` at and after that boundary so tests using `time.increaseTo(resolution)` see the lock take effect.
3. **listPosition / buyPosition / cancelListing** — atomic ownership transfer of a bet position; ETH refund on overpayment; market must still be open.
4. **resolveMarket** — only arbitrator, only at or after resolution time; records winning outcome.
5. **claimWinnings** — winners get net payout + reputation +; losers' calls succeed (mark `claimed=true`, reputation −, no transfer); both paths revert with `"Already claimed"` on retry.
6. **withdrawFees** — owner-only.

### Security choices

- **CEI ordering** on every external state-changing function: validate → effects → interactions. `bet.claimed = true` is set before any transfer to prevent reentrancy via fallback.
- **`ReentrancyGuard`** on `placeBet`, `claimWinnings`, `buyPosition`, `withdrawFees`.
- **`SafeERC20`** for all ERC20 transfers — tolerates non-standard tokens (e.g. tokens returning bool vs reverting).
- **Pull-style ETH** via low-level `call` (forwards all gas), with explicit success check.
- **Explicit `msg.value == 0` guard** on ERC20 paths to prevent users locking ETH in an ERC20 market.
- **Explicit refund** on `buyPosition` overpayment so the buyer never overpays silently.
- **`bet.bettor` reassignment** in `buyPosition` so the new owner — not the seller — can `claimWinnings`.
- **Custom errors avoided intentionally**: the assessment harness asserts string revert reasons (`"Too early"`, `"Only arbitrator"`, `"Market closed"`, `"Slippage exceeded"`, `"Already claimed"`); these are preserved exactly.

### Known centralization / trust assumptions

- **Oracle / arbitrator is trusted.** A malicious arbitrator can resolve any outcome. In production this would be a DAO-controlled multisig, a UMA optimistic oracle, or a Chainlink-style decentralized feed.
- **Owner can withdraw fees at any time.** Acceptable for a platform contract; in production fees would typically vest or split with stakers.
- **No emergency pause.** Out of assessment scope; would be added via `Pausable` for production.
- **`createMarket` is permissionless.** Anyone can spawn markets; the contract intentionally does not curate or gate question content. A production deployment would likely add a `marketFactory` allowlist or charge a creation fee.

### Notable improvements over the reference `PredictionMarket.sol`

- `SafeERC20` instead of raw `transferFrom` / `transfer`
- `address(0)` reputation system rejected in constructor
- `placeBet` rejects stray ETH on ERC20 markets
- `buyPosition` rejects self-purchase (buyer == seller)
- `listPosition` rejects zero price
- `unchecked { ++i }` on counters and the `getTotalPool` loop (gas)
- Fee constants expressed in basis points (`PLATFORM_FEE_BPS = 200`, `BPS_DENOMINATOR = 10_000`) for clarity and to allow non-integer fee rates in future
- Separate `LossSettled` event so off-chain indexers don't have to interpret a zero-payout `WinningsClaimed`
- Full NatSpec on every external function
- Private storage with explicit getters (`getMarket`, `getBet`, `getMarketBets`, `getUserBets`) — encapsulation, plus the option to evolve internal layout without breaking the ABI

## Dependency notes

`@nomicfoundation/hardhat-chai-matchers@^2.1.0` requires `chai@^4.2.0` but the repository pins `chai@^6.2.0`. I used `npm install --legacy-peer-deps` to install (and `--ignore-scripts` for safety review on first install). All tests still run on chai 6 because hardhat-chai-matchers' assertions are dispatched through `expect()` which is API-stable for the matchers we use.

## Gas report

Generated via `REPORT_GAS=true npx hardhat test` (optimizer enabled, 200 runs).

| Function | Min | Max | Avg |
|---|---:|---:|---:|
| `createMarket` | 279,180 | 393,540 | 325,539 |
| `placeBet` | 317,803 | 387,854 | 348,194 |
| `resolveMarket` | 54,068 | 73,980 | 59,757 |
| `claimWinnings` | 113,293 | 188,842 | 172,818 |
| `listPosition` | — | — | 76,650 |
| `cancelListing` | — | — | 28,408 |
| `buyPosition` | 94,652 | 101,691 | 99,345 |
| `withdrawFees` | — | — | 35,780 |

Deployment: **2,234,553 gas** (3.7% of 60M block limit).

Observations:

- `getTotalPool` iterates outcomes on every `placeBet`, `claimWinnings`, and `getPrice` call. For markets with many outcomes this becomes O(n) per call. A cached `totalVolume` is already maintained on `placeBet` — production version would replace the loop with a cached running total to drop `placeBet` by ~20–30k.
- `placeBet` could shave ~15k by packing `Bet` struct fields (`uint128 amount` + `uint128 shares` + `uint64 timestamp` + `bool claimed` into two slots).
- `_userBets[msg.sender].push(_betId)` in `buyPosition` is a write per purchase; the seller's old entry is not removed (history is preserved). Off-chain indexers should de-duplicate by current `bet.bettor`.

## Static analysis / lint

`npx solhint 'contracts/WorldCupBetting.sol'` — **0 errors**, 23 minor gas-style warnings (e.g. strict-vs-non-strict comparisons, >32-byte revert strings), all intentional design choices.

Custom errors were deliberately not introduced because the assessment harness asserts string revert reasons (`"Too early"`, `"Only arbitrator"`, etc.); changing to custom errors would break those assertions.

## CI

`.github/workflows/contracts-ci.yml` runs on every push/PR:

1. `npm install --legacy-peer-deps --ignore-scripts`
2. `npx hardhat compile`
3. `npx solhint 'contracts/WorldCupBetting.sol'`
4. `npx hardhat test`

## File layout

```
contracts/
├── contracts/
│   ├── WorldCupBetting.sol            # ← my implementation
│   ├── PredictionMarket.sol            # reference (untouched)
│   ├── ReputationSystem.sol            # provided (untouched)
│   └── MockERC20.sol                   # provided (untouched)
├── test/
│   ├── WorldCupBetting.assessment.test.ts  # 9 scenarios (untouched)
│   ├── WorldCupBetting.extra.test.ts        # ← my additional coverage
│   └── PredictionMarket.test.ts             # provided (untouched)
└── SOLUTION.md                         # ← this file
```
