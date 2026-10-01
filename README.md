# Polymarket BTC 5-minute strategy

The bot monitors BTC 5-minute UP/DOWN markets. It checks both outcome midpoints as soon as each window opens. A crossing of $0.75 in either direction triggers an entry on whichever side crosses; a tick may jump over $0.75 (for example, $0.74 to $0.76) and still trigger. The entry is an immediate CLOB FAK market buy with no $0.75 ask-price cap, so its execution price can differ from the midpoint signal. Polymarket's market-buy API takes a USDC amount rather than a share count, so the bot estimates the notional for the configured share target from the live ask book and records the actual filled quantity.

After entry, it rests a post-only GTC sell at $0.99. A best bid at or below $0.52 triggers a FAK market sell after the take-profit order is canceled and confirmed. Each stop-loss hit adds 50 shares to the next window, up to 550; each win subtracts 50, down to 50. An open position at the window close has its resting TP canceled and is held to the official market resolution. A resolution loss without a stop-loss hit does not add shares.

Demo mode starts with $1,000 and never signs or submits real orders. Taker fees in demo P&L use the configured estimate; maker rebates default to $0 until an actual amount is verified. Live orders require LIVE_TRADING=true and the existing wallet secret.

Run npm test for the strategy and fill-sizing checks; npm start starts the dashboard and bot.
