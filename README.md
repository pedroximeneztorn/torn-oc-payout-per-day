# Torn OC 2.0 Daily Payout

A userscript that adds a payout line to every Organized Crime 2.0 card on your faction's crimes page: your expected cut per slot, and what that works out to **per day** of planning, so you can tell which open slot is actually worth joining.

Click the `?` on the line to see the full working: raw payout, faction cut, success chance, chain pool and per-slot share.

## How it calculates

- **Cash crimes** use the observed range of successful payouts and the average weighted by how often each outcome happens (not just the midpoint).
- **Item crimes** (Stage Fright, Best of the Lot, Crane Reaction, …) value the drops at live item-market prices from the API, cached for 24 hours. Vendor-only items fall back to their sell price.
- **Chain crimes** (No Reserve → Bidding War, Stacking the Deck → Ace in the Hole, Manifest Cruelty → Gone Fission → Crane Reaction, Lock Stock → Hostile Takeover) share the final payout across every slot in the chain. Each earlier step also has to succeed and spawn the next.
- **Daily** divides by the time left in the queue if you can still join the crime, and by the scenario's nominal length otherwise.

## Settings

The settings panel sits under the OC tabs. The same options are in the Tampermonkey menu:

- **API key**: a public-access key is enough; it's only used to fetch item prices.
- **Faction payout %**: the share your faction pays out to participants (default 90%).
- **Success baseline %**: the assumed chance of a single crime succeeding (default 80%).
- **Force market sync**: refresh item prices now, without waiting for the 24-hour cache to expire.

## Credits

Cash payout figures come from the crowdsourced outcome data in [Torn OC Scenario Tracker](https://www.torn.com/forums.php#/p=threads&f=67&t=16458267&b=0&a=0) by Allenone [2033011]. Scenario lengths, slots and item drops come from the Torn wiki's Organized Crime 2.0 page.

## License

MIT
