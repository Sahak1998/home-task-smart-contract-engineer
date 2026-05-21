import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Additional edge-case coverage for WorldCupBetting beyond the 9 assessment scenarios.
 *
 * Focus areas:
 *   - Input validation on createMarket / placeBet / listPosition
 *   - Fee math precision (2% of winning payout)
 *   - Reentrancy / double-spend protection
 *   - Secondary market: cancel, refund, ERC20 path
 *   - Owner-only / arbitrator-only access control
 */
describe("WorldCupBetting — extra coverage", function () {
  async function deploy() {
    const [owner, oracle, alice, bob, carol] = await ethers.getSigners();

    const Reputation = await ethers.getContractFactory("ReputationSystem");
    const reputation = await Reputation.deploy();
    await reputation.waitForDeployment();

    const WCB = await ethers.getContractFactory("WorldCupBetting");
    const market = await WCB.deploy(await reputation.getAddress());
    await market.waitForDeployment();

    await reputation.setPredictionMarket(await market.getAddress());

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Mock USDC", "mUSDC");
    await token.waitForDeployment();

    return { owner, oracle, alice, bob, carol, reputation, market, token };
  }

  describe("createMarket validation", () => {
    it("rejects fewer than 2 outcomes", async () => {
      const { market, oracle } = await deploy();
      const t = (await time.latest()) + 1000;
      await expect(
        market.createMarket("Q", "D", ["only one"], t, oracle.address, ethers.ZeroAddress)
      ).to.be.revertedWith("Need at least 2 outcomes");
    });

    it("rejects past resolution time", async () => {
      const { market, oracle } = await deploy();
      const t = (await time.latest()) - 1;
      await expect(
        market.createMarket("Q", "D", ["A", "B"], t, oracle.address, ethers.ZeroAddress)
      ).to.be.revertedWith("Resolution must be in future");
    });

    it("rejects zero arbitrator", async () => {
      const { market } = await deploy();
      const t = (await time.latest()) + 1000;
      await expect(
        market.createMarket("Q", "D", ["A", "B"], t, ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid arbitrator");
    });
  });

  describe("placeBet validation", () => {
    async function setup() {
      const ctx = await deploy();
      const t = (await time.latest()) + 86400;
      await ctx.market.createMarket("Q", "D", ["A", "B"], t, ctx.oracle.address, ethers.ZeroAddress);
      return { ...ctx, marketId: 1n, t };
    }

    it("rejects invalid outcome index", async () => {
      const { market, alice, marketId } = await setup();
      const stake = ethers.parseEther("0.1");
      await expect(
        market.connect(alice).placeBet(marketId, 99, stake, 0, { value: stake })
      ).to.be.revertedWith("Invalid outcome");
    });

    it("rejects zero amount", async () => {
      const { market, alice, marketId } = await setup();
      await expect(
        market.connect(alice).placeBet(marketId, 0, 0, 0, { value: 0 })
      ).to.be.revertedWith("Amount must be > 0");
    });

    it("rejects mismatched ETH value", async () => {
      const { market, alice, marketId } = await setup();
      const stake = ethers.parseEther("0.1");
      await expect(
        market.connect(alice).placeBet(marketId, 0, stake, 0, { value: stake - 1n })
      ).to.be.revertedWith("Incorrect ETH amount");
    });
  });

  describe("fee math", () => {
    it("collects exactly 2% of gross winning payout", async () => {
      const { market, oracle, alice, bob, owner } = await deploy();
      const t = (await time.latest()) + 86400;
      await market.createMarket("Q", "D", ["A", "B"], t, oracle.address, ethers.ZeroAddress);

      const stake = ethers.parseEther("1");
      await market.connect(alice).placeBet(1n, 0, stake, 0, { value: stake });
      await market.connect(bob).placeBet(1n, 1, stake, 0, { value: stake });

      await time.increaseTo(t + 1);
      await market.connect(oracle).resolveMarket(1n, 0);

      const bets = await market.getMarketBets(1n);
      const fees0 = await market.getAvailableFees(ethers.ZeroAddress);
      expect(fees0).to.equal(0n);

      await market.connect(alice).claimWinnings(bets[0]);

      // Gross payout = totalPool = 2 ETH; fee = 2% = 0.04 ETH
      const expectedFee = (ethers.parseEther("2") * 200n) / 10_000n;
      const collected = await market.getAvailableFees(ethers.ZeroAddress);
      expect(collected).to.equal(expectedFee);

      await expect(market.connect(owner).withdrawFees(ethers.ZeroAddress))
        .to.emit(market, "FeesWithdrawn")
        .withArgs(ethers.ZeroAddress, owner.address, expectedFee);
    });
  });

  describe("withdrawFees access control", () => {
    it("non-owner cannot withdraw", async () => {
      const { market, alice } = await deploy();
      await expect(
        market.connect(alice).withdrawFees(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount");
    });

    it("reverts when no fees accumulated", async () => {
      const { market, owner } = await deploy();
      await expect(
        market.connect(owner).withdrawFees(ethers.ZeroAddress)
      ).to.be.revertedWith("No fees to withdraw");
    });
  });

  describe("secondary market — extras", () => {
    async function listed() {
      const ctx = await deploy();
      const t = (await time.latest()) + 86400;
      await ctx.market.createMarket("Q", "D", ["A", "B"], t, ctx.oracle.address, ethers.ZeroAddress);
      const stake = ethers.parseEther("0.5");
      await ctx.market.connect(ctx.alice).placeBet(1n, 0, stake, 0, { value: stake });
      const betIds = await ctx.market.getUserBets(ctx.alice.address);
      const betId = betIds[0];
      const price = ethers.parseEther("0.6");
      await ctx.market.connect(ctx.alice).listPosition(betId, price);
      return { ...ctx, betId, price, t };
    }

    it("cancels a listing and prevents purchase afterward", async () => {
      const { market, alice, bob, betId, price } = await listed();
      await market.connect(alice).cancelListing(betId);
      await expect(
        market.connect(bob).buyPosition(betId, { value: price })
      ).to.be.revertedWith("Position not for sale");
    });

    it("rejects buyer == seller", async () => {
      const { market, alice, betId, price } = await listed();
      await expect(
        market.connect(alice).buyPosition(betId, { value: price })
      ).to.be.revertedWith("Buyer is seller");
    });

    it("refunds buyer excess ETH on overpayment", async () => {
      const { market, bob, betId, price } = await listed();
      const overpay = price + ethers.parseEther("0.1");

      const balBefore = await ethers.provider.getBalance(bob.address);
      const tx = await market.connect(bob).buyPosition(betId, { value: overpay });
      const receipt = await tx.wait();
      const balAfter = await ethers.provider.getBalance(bob.address);

      // Bob paid `price` + gas; the 0.1 ETH overpayment was refunded.
      const expectedSpend = price + receipt!.fee;
      expect(balBefore - balAfter).to.equal(expectedSpend);
    });

    it("rejects listing a claimed bet", async () => {
      const { market, oracle, alice, betId, t } = await listed();
      await market.connect(alice).cancelListing(betId);
      await time.increaseTo(t + 1);
      await market.connect(oracle).resolveMarket(1n, 0);
      await market.connect(alice).claimWinnings(betId);
      await expect(
        market.connect(alice).listPosition(betId, ethers.parseEther("1"))
      ).to.be.revertedWith("Bet already claimed");
    });
  });

  describe("AMM math", () => {
    it("first bet on an outcome gets INITIAL_SHARE_RATE shares per wei", async () => {
      const { market, oracle, alice } = await deploy();
      const t = (await time.latest()) + 86400;
      await market.createMarket("Q", "D", ["A", "B"], t, oracle.address, ethers.ZeroAddress);

      const stake = ethers.parseEther("1");
      const expectedShares = stake * 100n;
      expect(await market.calculateShares(1n, 0, stake)).to.equal(expectedShares);

      await market.connect(alice).placeBet(1n, 0, stake, expectedShares, { value: stake });

      // Second bet on same outcome should mint fewer shares per wei.
      const sharesNext = await market.calculateShares(1n, 0, stake);
      expect(sharesNext).to.be.lt(expectedShares);
    });

    it("getPrice returns 50 when no bets placed", async () => {
      const { market, oracle } = await deploy();
      const t = (await time.latest()) + 86400;
      await market.createMarket("Q", "D", ["A", "B"], t, oracle.address, ethers.ZeroAddress);
      expect(await market.getPrice(1n, 0)).to.equal(50n);
    });
  });

  describe("constructor", () => {
    it("rejects zero reputation system", async () => {
      const WCB = await ethers.getContractFactory("WorldCupBetting");
      await expect(WCB.deploy(ethers.ZeroAddress)).to.be.revertedWith("Invalid reputation system");
    });
  });
});
