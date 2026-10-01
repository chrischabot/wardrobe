# How garderobe is actually used

A description of the wardrobe system as it exists in practice, drawn from the conversation record between February and September 2026, written to be designed from. Every claim cites the chat it comes from by date. Where the record does not settle something, the document says so rather than guessing.

## 1. Purpose and method

The previous specification failed because it was written from an assumption about what the system is for. This document replaces the assumption with evidence. It was produced by searching the whole chat record for wardrobe, outfit, shopping, laundry, sizing, disposal, and event conversations, reading the hits, and grouping what the owner actually did into use cases. For each use case it records how the interaction happens, what it reads and writes, what sources it draws on, how often it occurs, what a good outcome looked like, what went wrong, and what any system must therefore provide. The requirements are collected in section 11.

The short version, stated at the top so nothing that follows can be mistaken for a calendar generator: the system is a wardrobe the owner thinks with, out loud, through an assistant that holds the ledger. The ledger is filled and maintained entirely by conversation, from order emails, photographs, shop pages, and sentences. The daily board is the most frequent product and the one most people would name if asked what the system does, but the record shows it is one of twenty-eight uses in seven families, and the owner's own reactions place more value on the shopping, sizing, disposal, and learning uses than on the board itself. What failed, consistently and expensively, was the board and the integrity of the ledger under conversational editing. Everything else worked.

## 2. How the system came to be

The use grew in four stages, and each stage left a layer of expectation that the next one inherited.

**February to March 2026: menswear conversation without a ledger.** The earliest wardrobe chats are advice: a suit's drop for a 46" waist (18 Feb), whether a tobacco linen suits pale skin (14 Feb), why blazers fail on his body and why a teba or an ISTO work coat succeeds (14 Feb), Alan Paine polo sizing (7 Mar), a Drake's Games blazer in 46 or 48 (19 Mar), what to wear to a Shoreditch tech event to be memorable (2 Mar), a dramatic Saturday outfit around a herringbone coat (13 Mar). He also wrote a blog post about fourteen months of learning fabric, fit, silhouette, and palette (18 Feb), and built a menswear-writer voice for an advice agent (1 Feb). The wardrobe lived in his head and in Claude's memory.

**April 2026: rotations held in memory.** A 21-outfit list, then a fourteen-day themed plan with a teaching sentence per outfit ("The Quiet Authority", "Complementary Fire", "The Unexpected Turn"), then a 28-day sprezzatura rotation with sock and shoe assignments, jacket distribution tables, and swap logic (4 to 12 Apr). The anti-rut rule was written after two weeks of walnut chinos and brown Allbirds (24 Apr). A 25-pair, then 28-pair, merino sock rotation was bought as a deliberate buffer so a missed wash week would not become self-recrimination (Apr). The Paraboot sizing saga ran through April and May, and with it the first serious conversations about purchase regret.

**June to July 2026: the ledger and the MCP server.** The wardrobe MCP design was written on 10 June; the wear ledger began on 9 June; from 12 June the mandatory workflow was to call `outfit_pool`, draft from what it returned, and log every drafted set. The calendar became the delivery surface, with four or five options per day, in registers, from the weather. By 23 July the ledger held 153 items and the owner asked whether that was a lot for a 51-year-old who started not long ago. The v2 design proposal of 25 July catalogued fourteen failures from six weeks of operation. The repair brief of 28 July fixed availability at the source and specified that withdrawn options would be briefed, not substituted.

**August to September 2026: the body changed, the taste was written down, the protocol moved to the evening.** Significant weight loss made a size-48 cohort of jackets, ten pairs of Paraboots, and the heavy shirt cohort wrong on him. August was culling, sizing, mirror trials, Drake's drops, and the Marrkt consignment, all conducted through the ledger. The taste profile was compiled and approved on 30 August as the sole style reference. Colour metadata was backfilled across 152 items on 2 August. The perceptible-naming rule (31 Aug), the thermal rule (5 Sep), the week-long variety horizon and evening composition protocol (2 Sep), and the sock survey (4 Sep) followed. On 12 September the delivered board contained two withdrawn options with no replacement, and the connector was absent from the app.

## 3. Actors, surfaces, and sources

The system is not a Worker. It is this set of things, and a design has to account for each:

| Actor or source | Role in practice | Evidence |
|---|---|---|
| The owner, on a phone, mostly | Reads the board at 07:00; picks; argues; logs; late at night, audits and shops. Mornings are sacred and decision-light; late nights are where culls and purchases happen. | Throughout; 1 AM knitwear cull (12 Aug); "I was venting, not logging" (23 Aug). |
| Claude in the chat app | The operator: reads and writes the ledger, composes, repairs, answers, drafts, researches, fills web forms. | Throughout. |
| Claude Code and Maestro | The builder: receives briefs written in chat and changes the Worker. | Design proposal (25 Jul), repair brief (28 Jul), follow-up prompts (4 Jul), plan_week fix (2 Aug). |
| Gmail | Source of truth for purchases: Proper Cloth order emails with EU-numbered orders, PCF fabric codes, options, and delivery windows; Drake's WEB-numbered orders; Jeanstore JS orders; Pairs orders. Also the laundry service's damage history. | Positano shirt found by Gmail when chat search failed (16 Feb); seven shirts logged from orders (25 Aug); grey tweed Field Games from WEB138491 (4 Sep); ihateironing timeline built from eleven years of email (13 Aug). |
| Photographs | Identification and counting: jeans on a rail, a sock drawer, jacket photos for a listing, a shoe on a foot for fit, an outfit in a mirror for feedback. | 501s identified (13 Aug); sock survey (4 Sep); Marrkt photos matched (7 Sep); Paraboot loaded-fit photos (23 Apr); slate linen outfit photo (9 Aug). Elevator selfies were found unreliable for logging (12 Jun). |
| Shop pages and size charts | Fit checks against his measurements, retail prices for listings, drop timing, stock. | Drake's blazer chart (19 Mar); Orslow chart (13 Apr); Bleu de Chauffe dimensions corrected against the maker's own page (7 May); Shopify JSON endpoints for Marrkt retail prices (7 Sep). |
| Google Calendar | Delivery surface for the daily board; also the owner's own events (office days, walks, lectures) that the 2 Sep protocol reads. | Throughout from June; lecture calendar (1 to 4 Sep). |
| Weather (Open-Meteo, fetched by hand until the Worker did it) | Peak and morning temperatures, rain. | F7 (25 Jul); thermal rule (5 Sep). |
| The laundry service | ihateironing for eleven years, leaving after a pattern of damage; American Dry Cleaning Company identified as the replacement. Shirts and trousers go out; merino and alpaca socks never do. | 22 Apr claim escalation; 13 Aug replacement research and damage timeline; 9 Aug socks off the service model. |
| Marrkt and consignment services | Where the oversized cohort goes. Person-with-a-van services exist for everything else because boxes and couriers do not happen. | 13 Aug; 4 to 11 Sep. |
| Claude's memory files | Held the rules until the taste profile and ledger took them over; drift in memory was failure F11. | 25 Jul; 25 May memory-edit ceiling; 30 Aug profile. |

## 4. The use cases

Each entry has the same shape: what it is, how it happens, what it touches, how often, what good looked like, what went wrong, and what a system must provide. Requirement identifiers (R-numbers) are collected in section 11.

### Family A: ledger intake and maintenance

**A1. Adding items from order emails.**
How it happens: the owner says an order has been placed or has arrived, sometimes naming the maker, sometimes just "log the Proper Cloth order". The assistant searches Gmail, opens the confirmation, and creates one row per item with maker, product and fabric names, fabric code, price, size or fit specification, collar and cuff options, the order reference, and the expected delivery window. Items on order are benched until arrival; on arrival the owner says so and they go active. On 25 August seven Proper Cloth shirts and a Stratton cord were logged this way with delivery windows of 10 to 17 September; on 4 September the grey tweed Field Games was added from order WEB138491 and the navy wool chore from WEB138832; on 16 February the Positano shirt's full specification was recovered from a March 2025 email after the chat record failed. Frequency: several times a month in buying seasons. What good looks like: one sentence from the owner, rows created with the right status and thermal range, nothing to fill in. What went wrong: restocked socks were counted as on hand from order date (Aug); a promised set of updates from 29 August was never applied and had to be redone on 4 September; the Drake's mac bought in store on 29 August was not in the ledger on 31 August because there was no email to prompt it. Requirements: R1 (conversation creates rows), R2 (inbound status with arrival), R3 (order references stored), R4 (writes are confirmed by reading back, never promised).

**A2. Adding or identifying items from photographs.**
How it happens: the owner photographs a rail, a drawer, a box label, a shoe on a foot, or a garment on a hanger, and asks for identification, counting, or logging. On 13 August five 501s were identified darkest to lightest by matching the photo to existing rows, and the tiebreaker (cuff the hem for the selvedge line) was given for the pair the photo could not settle. On 4 September the alpaca and cashmere socks were catalogued from a photo with quantities per colour, consolidated from earlier inconsistent rows, and bed socks tagged indoor-only. On 7 September twenty-two jacket and ten shoe photos were matched to the consignment items. On 23 April two photographs of a Paraboot on a loaded foot changed the fit assessment materially. Frequency: a few times a month. What good looks like: the assistant reads the photo against the ledger, not against its own idea of the garment, and asks the one physical check that settles ambiguity. What went wrong: on 12 June an elevator selfie produced a misidentified jacket, shirt, trouser, and a shoe he does not own; photos are reliable for counting and matching to known rows, unreliable for identifying an outfit from scratch. Requirements: R1, R5 (quantity on a row), R6 (photo-to-row matching against the ledger, never free identification for logging).

**A3. Bulk status changes by sentence.**
How it happens: "the pickup has happened, these have all left the building, update garderobe" (11 Sep) retired the remaining consignment rows and deleted a fabricated one. On 4 September, from spoken instructions, roughly thirty rows changed status: two jackets back from the tailor set active, a 48 confirmed retired, another confirmed retired for sale, three rugbies retired, the Chasseur and jungle jacket benched to the closet, ten Paraboots retired with sizes recorded, seven shirts benched pending arrival. "Bench the whole welted fleet until I say my feet have healed" (30 Aug) took every leather shoe out of planning at once. Frequency: weekly in transition months, otherwise a few times a month. What good looks like: the assistant resolves each named item to exactly one row, applies the change, reads back the resulting state in a short confirmation, and stops. What went wrong: hedges and hypotheticals appended to confirmations (11 Sep); items with no row invented as rows (the PWVC Observer); items referenced by names the owner does not use. Requirements: R7 (batch status verbs with idempotency), R8 (exact item resolution with the owner's aliases), R9 (no row is ever created as a side effect of a status change), R10 (terse confirmations, no hedges).

**A4. Correcting attributes in narrative.**
How it happens: a bad board or a wrong sentence reveals a wrong value, and the owner states the truth: cotton-linen floors at 28°, pure linen at 30° (23 Aug and later); the lightweight oxford floor lowered to 12° then 10° so cool-morning boards surface them (5 Sep); alpaca ceiling 12° because he prefers merino until it is properly chilly (4 Sep); trousers are single-wear (12 Aug); socks are not laundered by the service (9 Aug); the 990v4 "Mahogany" is rust, not brown (Aug); the Chasseur's range flatters it (31 Aug). On 2 August colour family, value, temperature, saturation, and pattern scale were backfilled across 152 items in three batches. Frequency: constant in the first months, tapering as the ledger converged. What good looks like: the correction is applied fleet-wide in one pass, with a rule recorded so it cannot regress. What went wrong: the same correction had to be given repeatedly (Michael cerf noir UK 8.5, corrected "repeatedly" in August); ceilings were raised on cotton jackets to defeat a validator that judged outerwear on the peak (5 Sep), which is the ledger being falsified to route around a bug; the assistant asserted "15 oz canvas" for the D-43 from its own note when the listing says 16.5 oz cotton (10 Sep). Requirements: R11 (cloth rules enforced as constraints, not as values to be remembered), R12 (bulk attribute edits), R13 (the assistant never asserts fabric or inventory facts from memory).

**A5. Identity reconciliation.**
How it happens: a count looks wrong and the conversation works out why. On 23 July "one too many non-Levi denims" led to the discovery that two pre-ledger "denim" rows were the cream and dried-sage Akita 5-pockets entered twice, and that the Spoke jeans had never been entered. On 12 August the knitwear count of nine against a shelf of five led to two retirements and one premature burial reversed. On 4 September inky-blue and true-black alpaca rows were consolidated into the five plain names he uses. Frequency: monthly. What good looks like: the assistant presents the candidates with what distinguishes them and asks one question; the owner decides; the merge preserves wear history. What went wrong: a confident wrong guess is worse than the question; deleting the wrong row loses history. Requirements: R14 (explicit merge verb that moves wear history), R15 (no silent deletes).

**A6. Inventory questions.**
How it happens: "how many trousers do we have?" (23 Jul, with a brand and type breakdown), "counts per category, descending, it feels wrong otherwise" (12 Aug), "what's in the pool at 8°?" (12 Aug), "which merino do I have?" (28 Aug). Frequency: weekly. What good looks like: an exact count from the live ledger with a one-line shape ("five denim, four cords, two flannels, the rest chinos"). What went wrong: counts computed from stale memory; a `search` that missed items in `breaking_in` status (13 Jul) so the wardrobe matrix under-counted until both statuses were pulled. Requirements: R16 (one query that returns the complete active-plus-inbound inventory with status, never paginated silently).

### Family B: daily dressing

**B1. The board: several outfits for a day, from the weather, delivered to the calendar.**
How it happens: from June, four or five options per day (three SPREZZ and two RL in August; five in the September format), composed from the pool after temperature and availability filtering, each with a one-sentence rationale that teaches a principle by osmosis, then the labelled lines, projected to a 07:00 all-day event. From 2 September composition moved to the evening before, from the forecast peak for shirts and trousers and the morning reading for outerwear, the last fortnight's wears, and his calendar. The canonical format is in the taste profile: day line ending "today is about ⟨vibe⟩", five outfits, jacket if any, shirt or jumper, trousers, belt with optional scarf or tie, socks and shoes naming a sneaker and a welted alternative. Frequency: daily. What good looks like, in his words: a morning that is a pick, not a negotiation; suggestions with conviction, one loud piece worn with purpose or a wrong-on-paper pairing executed with confidence; never "blue stripes on a chino". What went wrong, in order of how often: composed before reading the rules or the ledger (every morning since April, by his account on 2 Sep); safe or repetitive sets (Apr rut, 23 Aug "too tame"); unavailable items offered (12 Sep chino five days in the hamper); withdrawn options never replaced (12 Sep); the navy fallback on swaps (Sep); outerwear judged on the peak (5 Sep); the format never rendered exactly by the Worker (Aug to Sep); a heavy shirt under a jacket on a 14° walk (2 Sep); linen offered at 23° (23 Aug); bare-ankle suggestions (18 Jun); manufacturer names on the board he cannot map to a hanger (31 Aug); "first wear" copy when the ledger simply started in June (12 Jun); operational notes in the calendar copy (12 Jun). Requirements: R17 through R26 in section 11.

**B2. Logging what was worn.**
How it happens: "worn opt 3" as the whole morning (the 28 Jul brief's end state); "I wore option 4" with a belt and shoes named (4 Sep); off-plan by description: beige chino, thin-stripe oxford, biscuit socks, navy 990v4 (31 Jul), or the same after venting about the board (23 Aug), or today, dark jeans, light blue stripe oxford, golden yellow merino (12 Sep). Also amendments and corrections: belts and shoes taken back out of the wash state (4 Sep); "don't re-log today once I'm already dressed" (31 Jul). Frequency: daily. What good looks like: one message, zero follow-ups, and the system says what changed downstream. What went wrong: the assistant asked which items were worn when the owner was venting (23 Aug); logging mid-morning created churn; a wear could not be amended without raw SQL (F2); logging did not touch forward plans (F14); on 12 September nothing could be logged at all because the connector was gone. Requirements: R27 (wear logging by option number or by description with exact alias resolution), R28 (amend by supersession), R29 (logging cascades to every open board in the same call and reports the consequence), R30 (a logging path that does not depend on the chat connector).

**B3. Laundry in the owner's own terms.**
How it happens: "laundry is going out today, back Saturday" (31 Jul); "everything returned except what I wore yesterday and the stone cavalry twill, mark those dirty until the 8th" (2 Aug); "returned today but today's and yesterday's wears are still dirty" (24 Jul, the F8 case); "socks washed" as a manual event because merino is hand-washed on roughly a fortnight's cadence and never sent out (9 Aug, 3 Sep); a spill or a shirt that never made it into the bag. Frequency: weekly for the service, fortnightly for socks. What good looks like: the literal dates he gives, no interpretive offsets (he corrected "Saturday afternoon is too late for Saturday morning" to "the 1st", 31 Jul); items unavailable from wear until the cycle that collects them returns. What went wrong: same-day return marking recent wears clean (F8); footwear inheriting a laundry state (31 Jul); belts and shoes in cooldown (4 Sep); sock availability figures that were plausible fiction (9 Aug). Requirements: R31 (hamper bound to cycles at pickup), R32 (two laundry channels, service and hand-wash), R33 (never-laundered roles have no laundry state).

**B4. Arguing with the board and same-day steering.**
How it happens: this is the use case the previous specification missed entirely, and the record is thick with it. "I feel like wearing something dramatic tomorrow, long herringbone grandad coat, new charcoal trousers, what else?" (13 Mar). "Quiet Authority, but it's 22° tomorrow, tweed is out, make me a new one" (9 Apr). "Pink oxford, jungle jacket, walnut or navy chinos? And olive NB, right? Socks? Belt?" then "what would be a contrast sock colour?" (21 May). "The rebuilt suggestions are too tame; I wore jeans and the wide stripe, the archetype of unexciting; carry the boldness brief forward" (23 Aug). "Slate linen over tobacco linen, new Paraboots, beige socks, does this work?" with a photo, then "no brown socks available, grey or black?", then "you didn't check the ledger before theorising" (9 Aug). "Navy twill? It's such a dark navy" and "tie, must have or too much?" (30 Mar). "What does the 14° morning do to the shirt choice?" (2 Sep). Frequency: several times a week. What good looks like: the assistant reasons from the ledger and the day, answers the specific question, and, when it changes an outfit, the change lands in the board and the log without a separate step. What went wrong: theorising without checking availability (9 Aug); rebuilding a whole day when a swap was asked for; regressing to raw server candidates when a day was rebuilt (23 Aug). Requirements: R34 (steering verbs: swap one slot, rebuild one option under a brief, rebuild a day under a brief, each producing a validated result), R35 (a brief carries forward through a rebuild), R36 (any accepted change lands in the board).

### Family C: taste, learning, and direction

**C1. Colour and composition theory, asked and answered.**
How it happens: "why navy 990 rather than grey or charcoal with a grey chino and a dark navy shirt?" (18 Jun: avoid tripling one neutral, let the foot echo a colour already present higher up). "Reims black for cool, café Michael for warm, aren't we missing a bridge?" (23 Apr: a long argument across whisky suede, Chromexel bordeaux as it actually renders, cool brown, with the counter-theory that two committed poles and a neutral sneaker is a coherent system and the gap may not exist). "What's a contrast sock colour for pink, walnut, olive?" (21 May: mustard first, then burgundy, rust, cherry, pink; skip bottle green, royal blue, grey). The fourteen-day plan of 4 April taught one principle per outfit: value inversion, complementary fire, greyed adjacency, echo not match. Frequency: weekly, often inside B4. What good looks like: the reasoning is specific to his pieces and his palette, admits counter-arguments, and leaves him able to make the next call himself; he said the sentences on the board should teach through osmosis. What went wrong: reasoning about an abstract burgundy rather than the real leather (23 Apr, corrected by the owner's eye); theory offered before the ledger was checked (9 Aug). Requirements: R37 (the conversation has read access to every attribute the theory needs: family, value, temperature, saturation, texture, pattern), R38 (the board's sentences are the same teaching, one principle each).

**C2. Direction changes, given once and expected to hold.**
How it happens: "brown is welcome but must not be the default; rotate all three Allbirds" (24 Apr). "Every day's options need genuine character moves; one loud piece; never commit raw candidates" (23 Aug). "Blazers are back, but only the academic register, texture and flecked cloth, never City or church" (30 Aug). "The variety horizon is the week, not three days; I own twenty trousers so I never repeat last week" (2 Sep). "Never fall back to navy when swapping" (2 Sep). "Compose in the evening, not the morning" (2 Sep). The owner also anticipates directions not yet given: "too French, I'm missing the Ivy angle", "too safe, use my red pieces more". Frequency: monthly, and each one is meant to be permanent. What good looks like: the direction applies from the next board onward and never has to be repeated. What went wrong: every one of these was restated by hand more than once; memory drift (F11); compressed slogans that then misled composition, which is why the 30 August profile forbids one-line summaries. Requirements: R39 (standing directions are data the engine reads, with a place to state them in a sentence and see them applied), R40 (a direction is testable: the board can be checked against it).

**C3. Fabric, construction, and thermal education.**
How it happens: Clark versus American Pima weights and weaves, why the Clark feels lighter despite the category (7 May). Fused versus sewn collars as a hard gate, verify construction before recommending any maker (4 Sep). The thermal rule: shirt and trouser for the peak, jacket for the morning, a lightweight oxford under a jacket at 13 to 16° is just right, a heavy shirt there is far too hot (5 Sep). Felted and milled wools are weather-engineered; the Chasseur is light rain only (31 Aug). Linen is for 28° and above (12 Jun, 23 Aug). Frequency: fortnightly, and the results become ledger rules. What good looks like: the assistant verifies against the maker's page or the cloth, and the conclusion is encoded once. What went wrong: cloth facts asserted from notes (10 Sep); wool called rain-fragile (31 Aug). Requirements: R11, R13.

**C4. Writing about clothes.**
How it happens: a blog post on fourteen months of learning (18 Feb); a Derek Guy voice guide for an advice agent (1 Feb); the taste profile compiled from the record and approved verbatim (30 Aug); the Marrkt consignment introduction written in his voice (4 Sep). Frequency: occasional. What good looks like: prose he recognises as his, no AI tells, counter-arguments kept in. Requirements: R41 (the conversation can read the whole ledger and wear history as material for writing).

### Family D: shopping and acquisition

**D1. Gap analysis grounded in the ledger and the wear record.**
How it happens: "given my sock collection, which Pairs merino should I buy to expand our options, or get more of?" (28 Aug): the assistant pulled socks, wear equity sorted by last worn, and the trouser palette, and recommended dark plum and Parma violet as the absent quarter with anchors already in the wardrobe, white at a discount for cream and limestone days, a second inky blue as the workhorse, and nothing more in bright yellow or red because their wear was low. A stylist's matrix (Base, Layers, Shoes, Accessories against Comfort, Confidence, Creativity) was populated from 134 items and showed creative layers as one piece in fourteen, with a counter-argument that sober outerwear over expressive shirting may be intentional (13 Jul). Three Allbirds colours chosen against the planned outfits (5 Apr). "Every heavy layer I own is navy, so an olive sub-10° piece is the gap the Keeper would fill" (11 Sep). Frequency: monthly. What good looks like: recommendations framed by what each piece works with and why it earns its place; his own words are "considered additions, not impulse". What went wrong: nothing structural; the wear data was thin because logging began in June, and the assistant was careful to say so. Requirements: R42 (wear equity and last-worn per item, queryable by category), R43 (palette and attribute queries across categories).

**D2. Fit and size checks from body measurements against garment measurements.**
How it happens: the owner gives a chart, a link, or a half-chest figure, and the assistant computes ease against his measurements (44" chest, 44" waist since about July; earlier 46" waist; 186 cm; shoulder about 20 to 20.5"). Drake's Games blazer 46 versus 48 with shoulder and chest ease reasoned separately (19 Mar). Alan Paine polo 48 versus 50, tapered cotton with no give (7 Mar). Orslow denim shirt, size 5 too snug (13 Apr). A size 44 jacket's 25.9" half chest over old and new shirts (21 May). Teba and ISTO silhouettes as the formula that works on his body: high closure, no deep V, straight cut, heavy cloth (14 Feb). De Bonne Facture's chart is not Drake's chart: his grey Grandfather Coat is a 56, the camel Grandad would be about a 52 (11 Sep). Paraboot is UK 8.5, learned expensively (May). Frequency: weekly in buying seasons. What good looks like: numbers, the specific risk (shoulder, waist, drop), and a verdict; the return policy named when it matters. What went wrong: the assistant misread the memory of which Paraboot was donated and built an argument on it (16 May); memory of measurements went stale as the body changed. Requirements: R44 (body measurements and per-maker size verdicts stored as dated facts the conversation reads), R45 (garment measurements storable per item).

**D3. Temptation checks: talk me out of it, or into it, with the ledger open.**
How it happens: the Clifford desert boot, fascinating copy, "skip: same grammar as the Astorflex you returned, third warm shoe before the other two have broken in, a fantasy of a life you don't have" (24 Apr). A 1 AM Alan Paine sale declined, with the cricket jumper's tapered block named as wrong for his straight midsection, and the trouser-shortage joke answered with wear-cycle economics before the joke was revealed (12 Aug). The Bordeaux Michael rejected once the real Chromexel colour was looked at rather than the abstract burgundy (23 Apr). The completionist pattern named across rugbies, denim shirts, and jeans, with one friction rule: name what gets benched before checkout, not after the confirmation email (13 Aug). The Salomon bought to close the waterproof-trainer gap, then expected to be returned on spending grounds (28 to 31 Aug). The Keeper jacket weighed against a DBF camel coat, with the honest question of FOMO versus gap left open (11 Sep). Frequency: weekly in drop season. What good looks like: the ledger consulted first, the honest case both ways, and no cheerleading. What went wrong: nothing structural; the record shows this working. Requirements: R42, R43, R46 (a "what would this displace" query: the rotation slot an item would occupy and what already occupies it).

**D4. Drop timing, store visits, where to buy.**
How it happens: Drake's transitional drop on 27 August mirroring last year, the main autumn drop expected around 22 to 24 September, the winter drop in early November (29 Aug); a tweed Games sold out within two hours (11 Sep); the mac tried across the full size run in store on day-one stock (29 Aug); a Paris day at De Bonne Facture as a way round import costs (24 Feb); Trunk for a Mismo bag, verify the 16" laptop fits in person (7 May); StockX for deadstock 990v4 colourways (Aug). Frequency: monthly. What good looks like: dates, the reason to go in person, and what to check there. Requirements: R47 (reminders and calendar entries for drops and ticket windows, which the lecture work already does).

**D5. Completing a register with accessories.**
How it happens: the distracted-professor accessories: tortoiseshell eyewear, a Billingham satchel, a linen pocket square, a field watch on a NATO (9 Apr), followed by the watch bought at 42 mm for his frame and the satchel chosen (12 Apr); the burgundy silk knit tie and the rust knit tie as the things that unlock blue shirts (Apr). Frequency: occasional. Requirements: R48 (accessories are ledger items with register tags, offered by the board as the optional line).

**D6. Suitability doubts about colour against skin, frame, and age.**
How it happens: "I'm 50, very pale, closely trimmed hair; is tobacco too strong for my skin and weight?" (14 Feb), answered with undertone reasoning and the swatch-to-the-face test. Frequency: rare, and personal. Requirements: none beyond the conversation existing.

### Family E: disposal and lifecycle

**E1. Culls after the body changed.**
How it happens: the 1 AM knitwear cull applying the honesty test piece by piece (does it tell the truth about what it is, where it is from, what it costs), four pieces out, four keepers plus the bouclé restored (12 Aug); the merino sweaters ("a regret with sleeves") and the two Fair Isles sized for 120 kg (12 Aug); the heavy-shirt cohort strategy: triage and replace a few a quarter, alter one, wear the big ones open as shirt-jackets, retire the rest (11 Sep); 27 items benched to storage at the early-autumn transition. Disposals get silence, not retirement notes ("garbage gets silence", 12 Aug). Frequency: seasonal. What good looks like: the ledger reads exactly as the shelf does when the session ends. What went wrong: the count of nine against a shelf of five; a premature burial. Requirements: R7, R14, R15, R49 (a "reconcile against what you can see" mode: list the category, the owner names what is there).

**E2. Consignment end to end.**
How it happens: the exit plan chosen because it has the fewest steps (Aug); the draft written from the ledger in his voice, revised across rounds, alteration mentions removed (4 Sep); the ten Paraboot boxes inventoried with sizes corrected from handwritten labels (7 Sep); full retail prices sourced from the makers' Shopify JSON rather than what he paid; twenty-two jacket and ten shoe photos matched to items; the Marrkt seller form filled by browser automation, including a shadow-DOM condition field; 26 items at £5,865 with an expected payout of about £3,500, which is the fund for the replacement wardrobe (7 Sep); the pickup confirmed against the list, twelve by the door, and the rows retired (11 Sep). He stated that the task chain is not one he can complete unaided and that his only actions should be paste and box; DHL collection was rejected because boxes and packing do not happen; person-with-a-van services were found for the audio and the TV (13 Aug). Frequency: once per body change, but the highest-effort and highest-value single project in the record. What good looks like: exactly what happened. What went wrong: a fabricated Observer row; a hedge appended to a clean count. Requirements: R50 (a `for_sale` state distinct from `retired`, with a listing record: retail price, size, condition text, photo references), R51 (the conversation can act on the web on his behalf), R9, R10.

**E3. Alterations planning.**
How it happens: side seams on thirty shirts, batched by wear frequency, wait for the weight to plateau (13 Feb); sleeves shortened on the cotton-linen Games and the General's Overcoat with cuff tabs repositioned (29 Aug); the D-43's throat latch repaired (4 Sep); items marked as at the tailor and returned. Frequency: seasonal. Requirements: R52 (a bench reason "at tailor" with expected return, and notes on what was altered).

**E4. Storage and organisation.**
How it happens: hallway coat storage, valet arms, under-bed boxes for fourteen shirts, "editing, not triage under pressure" (7 Mar). Frequency: rare. Requirements: R53 (a location field: hallway, closet, storage) is the most the ledger needs.

### Family F: events, seasons, and social intent

**F1. Dressing for an event with a social goal.**
How it happens: a Vercel Labs evening in Shoreditch, the crowd predicted as normcore, the outfit chosen to be memorable without trying, and the speaker researched for conversation (2 Mar); a dramatic Saturday lunch and stroll (13 Mar); a Drake's store visit dressed in the brand's palette (21 May); "I'm going on a date, I want something fancier" as the owner's own example of what the system must handle (13 Sep). Frequency: a few times a month. What good looks like: the room read, the register chosen, the pieces named from the ledger, the shoes chosen for the distance to be walked. What went wrong: never served by the board; always served by conversation. Requirements: R34 (rebuild under a brief with occasion, register, and formality), R54 (the owner's calendar events readable as context for the day's board).

**F2. Seasonal transitions.**
How it happens: "when might I see the first 15° day?" answered with London climatology and the morning-window logic (12 Aug); the seasonal rotation and temperature scheduling session (25 Aug); 27 items benched to storage and the calendar rebuilt (early Sep); "this side of dressing is still new to me" about heavy winter layers (11 Sep). Frequency: quarterly. Requirements: R55 (seasonal benches with expected return; a view of what becomes wearable at a given temperature).

### Family G: decision support and the person

**G1. Sitting with purchase regret and fit grief without being redirected.**
How it happens: the Paraboot project pile, two of three pairs unwearable, "I hoped for shoes instead so I could feel good having them in my daily life" (23 Apr); "another £309 wasted, failing at this so hard" after the Drake's boots (16 May); the assistant's better responses stayed with what he said rather than reframing. Frequency: occasional. Requirements: none technical; a behavioural requirement on the conversation.

**G2. Designing around his own constraints.**
How it happens: the sock buffer sized so a missed wash week does not become self-recrimination (Apr); no boxes, no self-packing, no couriers, pickup by a person only (13 Aug); the assistant drafts so his only action is paste (29 Aug); no per-pair accounting homework again after the sock survey (4 Sep); mornings decision-light because sleep is limited; venting mode is not logging mode (23 Aug); confirmations terse, no hedges (11 Sep); no bracketed placeholders in documents he will send on; when he has decided to bin something, no errand alternatives. Frequency: these govern everything. Requirements: R56 (every surface designed so the owner's action is the smallest possible one: a tap, a sentence, a paste).

**G3. The through-line.**
A wardrobe rebuilt twice in a year around a changing body, reasoned with over months, where the ledger is the memory that the conversation lost every session. The record shows that the ledger became trustworthy only when its rules were written down outside the assistant's memory, and that the assistant's value lay in reading the ledger well, not in remembering it.

## 5. The standing rules, as the record established them

These are the rules the owner has stated, with the date each was set. A system that does not encode every one of them will be corrected on the first morning it forgets one. They are grouped by what they govern.

**Thermal and layering**
- Shirts, trousers, and socks are judged against the day's peak temperature; outerwear against the morning reading. An 11° morning with a 19° afternoon is a 19° outfit under a jacket. (5 Sep)
- At 13 to 16° a jacket goes over a lightweight oxford only; Pima oxfords, twills, and flannels count as heavy and are for peaks in the low teens. On a 14° walking morning the D-43 over a lightweight oxford was "just right to slightly warm"; a heavy shirt under a jacket "would have been way too hot". (2 and 5 Sep)
- No outerwear above 24°. (18 Jun)
- Linen and cotton-linen are for hot days: cotton-linen from 28°, pure linen from 30°. (12 Jun, 23 Aug)
- Alpaca socks from 12° down; merino until then. Bed socks are indoor only. (4 Sep)
- The lightweight oxford floor is 10°, set so cool-morning boards never hide them. (5 Sep)
- On hot days, mesh sneakers over closed leather. (18 Jun)
- The full-length mac is too much for a dry long walk; a chore or work coat instead. (2 Sep)
- The waxed Chasseur is light rain in moderate weather only; felted and milled wools (the melton pea coat, loden, felted recycled wool) are weather-engineered and fine in rain. (31 Aug)

**Socks and footwear**
- Socks are always worn; no bare-ankle or sockless suggestion, ever, for a reason the owner has given and does not need repeated. (18 Jun)
- Every outfit names a sneaker and a welted alternative; the day decides at the door. (30 Aug profile)
- Welted shoes carry the `no_10k_walks` tag: all-day wear is fine, deliberate long walks are not. The whole welted fleet and both 990v6 pairs are benched from 30 August until he says his feet have healed.
- Footwear, belts, and outerwear never launder and have no cooldown. (25 Jul, 4 Sep)
- Paraboot size is UK 8.5. The Michael cerf noir is 8.5; the ledger's "UK 9" was wrong. (Aug, repeatedly)
- The dark-earth sneaker slot is closed by the 990v4 in dark olive; there is no residual "brown 990v4" gap to chase. (31 Aug)

**Variety and composition**
- A shirt or trouser worn in the previous seven days is a repeat. The horizon is the week; the fortnight is checked. (2 Sep)
- Brown is welcome but never the default; rotate all the sneakers. (24 Apr)
- Every day's options need genuine character: one loud piece with quiet supports, or a wrong-on-paper pairing worn with confidence. "Blue stripes on a chino" is the archetype of the unexciting. Never commit raw server candidates. (23 Aug)
- Never fall back to navy when swapping a piece out. (2 Sep)
- Compose from the taste profile read in full; no one-line summaries. (30 Aug)
- Blazers only in the academic register: flecked, textured, warm; never City or church. (30 Aug)
- The two failure modes are the clown and the drone; the target is the hard-to-place third thing. (profile)

**Laundry**
- Shirts and trousers go to the service; trousers are single-wear. (12 Aug)
- Merino and alpaca socks are hand-washed by the owner on roughly a fortnight's cadence and never go to the service; each wash is a manual event. (9 Aug, 3 Sep)
- Return dates are literal; no interpretive offsets. (31 Jul)
- Items worn after a pickup wait for the next pickup. (24 Jul)

**Ledger truth**
- Names are what the owner can see at the wardrobe. Jeans are light, mid, or dark and nothing else; manufacturer wash names mean nothing to him. (31 Aug)
- Shirt aliases are exact: "blue stripe" is PCF4677, "light blue stripe" is PCF4403, "wide stripe" is PCF4340, "extra wide stripe" is PCF4628. (2 Sep)
- A zero wear count means unlogged, never unworn. Nothing about condition is inferred from counts. (4 Sep)
- Restocks and new items are benched until they arrive. (Aug)
- Rows are never created for items that do not exist; a disputed row is benched and named, not deleted without instruction, and a fabricated row is deleted on instruction and never raised again. (31 Aug, 11 Sep)
- Query the live ledger before asserting any inventory fact. (standing)
- Cloth facts come from the maker's listing, not from notes. (10 Sep)
- Body measurements: 44" chest, 44" waist, unchanged for two months as of 30 Aug; PWVC size 6; Drake's 46; DBF around 52 for coats; Paraboot 8.5; rugbies XL.
- Disposals get silence. Bin means bin; no errand alternatives.

**Interaction**
- Mornings are a pick, not a negotiation; a morning correction is a swap, never a rebuild. (2 Sep)
- Calendar copy is morning reading: no operational metadata, no status headers, no "in the wash, deferred" notes. Those belong in chat. (12 Jun)
- One principle per outfit, taught in prose, never announced. (12 Jun)
- Venting is not logging; do not ask which items were worn until asked to log. (23 Aug)
- Confirmations are terse; when counts match, say so and stop; no hypothetical hedges. (11 Sep)
- Less text, more signal in operational sessions: counts, bucketed failure reasons, one paragraph of observation. (2 Aug)
- Consult the record before re-deriving a verdict; do not jump to abandon-it-all conclusions. (standing)
- No per-pair homework after the one comprehensive survey. (4 Sep)

## 6. The ledger as it is actually used

The tables below describe the data the conversations read and write, regardless of the current schema. This is what a rebuilt ledger must hold, named as the owner names it.

**Item fields in use:** name (perceptible), aliases (the owner's own phrases), category (shirt, knit, trouser, outerwear, footwear, sock, belt, tie, scarf, accessory), sub-type (lightweight oxford, Pima oxford, twill, flannel, rugby, chino, jeans, cord, fatigue, five-pocket, chore, field, mac, Games blazer, teba, work coat, pea coat, overcoat, sneaker, welted derby, loafer, boot), maker, maker's product and colourway name (never rendered), fabric and weight (from the listing), fabric code, size and fit specification ("new manual measure"), price and currency, order reference and source, acquired date, expected arrival, status, colour family, colour value, colour temperature, saturation, pattern and pattern scale, temperature range, rain fitness, walk fitness (`no_10k_walks`), laundry behaviour (service, hand-wash, never), wears per cycle, quantity for identical items, location (hallway, closet, storage), notes, and for sale-bound items the retail price, condition text, and photo references.

**Statuses in use, and what they meant:** `active`; `breaking_in` (footwear being worn in, still plannable); `secondary` (an at-home or occasional piece the planner deprioritises without pretending it does not exist); `benched` with a reason (season, storage, feet healing, awaiting arrival, at the tailor, disputed, in the closet as occasional); `for_sale`; `retired` (gone, history kept). The distinction between benched-occasional and active matters to the board: the Chasseur and jungle jacket are "in the closet", available if asked for, never offered unprompted.

**Wear record:** date, which option if from the board, the items by role, and amendments as a chain rather than edits. Wear counts date from 9 June 2026 and are meaningful only from then.

**Laundry record:** cycles with pickup and return dates; hamper entries per item and unit bound to a cycle at pickup; a hand-wash channel for socks cleared by a manual event.

**Quantities:** merino socks by colour (47 pairs across seventeen colours as surveyed 4 Sep), alpaca socks by colour (fourteen pairs across five), jeans by shade (six 501s in three shades). These are one row each with a quantity, because the owner cannot and will not tell identical pairs apart.

**Standing directions:** the anti-rut rule, the boldness brief, the academic-blazer terms, the navy rule, the variety horizon. Today these live in memory and the profile; they were restated by hand each time they were missed.

**Wardrobe-level facts:** body measurements with dates; per-maker size verdicts; the laundry service and its cadence; the location for weather.

## 7. The sources and their shapes

- **Proper Cloth order emails:** order numbers `EU` followed by seven digits, one line per shirt with the fabric name, the `PCF` code, collar, cuff, placket, hem, buttons, the fit name, price in GBP, and an estimated delivery window. Remakes reference the original. Returns and remakes have a 60-day window.
- **Drake's order emails:** `WEB` followed by six digits; product name, colour, size, price; drops are announced by email and sell through in hours.
- **Jeanstore:** `JS` followed by six digits; Levi's 501 wash names and PC9 codes.
- **Pairs Socks:** colour names that the owner uses verbatim (inky blue, correct grey, deep earth brown, strong blue, forest green, golden yellow, fire red, biscuit beige, milky tea, blue jean, pine green, true black, dark plum, grass green, royal purple, soft grey).
- **StockX and eBay:** deadstock New Balance colourways; the listing name is not the perceptible name.
- **Photographs:** rails, drawers, box labels with handwritten overrides, shoes on feet, mirror shots. Reliable for counting and matching to rows; unreliable for identifying an outfit from nothing.
- **Shop pages:** garment measurements in inches or centimetres, sometimes mislabelled by the retailer; the maker's own page is authoritative.
- **Weather:** Elephant and Castle; peak of the day and the 08:00 reading; rain.
- **The owner's calendar:** office days, walks, museums, Gresham and LSE lectures with booking reminders.

## 8. The person's constraints, as design inputs

These are not preferences to accommodate; they are the conditions under which the system is used, and every previous failure that mattered to him was a failure to respect one of them.

- He is on a phone almost always. Anything that needs a desktop, a terminal, or a secret he does not hold will fail at the moment it is needed (12 Sep).
- Mornings are decision-light because sleep is limited. The morning surface is a glance and a tap.
- Late nights are where audits, culls, and purchases happen; the assistant's job then is to be honest with the ledger open.
- Long task chains with physical steps do not complete unaided: photographing, listing, packing, posting. Anything that requires them must be redesigned so his action is one step.
- He walks 11,000 or more steps a day; footwear comfort outranks everything at the feet.
- He cannot tell identical pairs apart and will not do per-unit accounting.
- He names things by what he sees. A system that speaks in maker names is speaking a foreign language.
- He corrects cleanly and expects the correction to be permanent. Being corrected twice on the same fact is the failure that costs the most trust.
- He notices AI tells, hedges, filler, and narration of his own words back to him, and each one costs goodwill at a moment when goodwill is thin.
- He does not want the stock line about professional help when he is low.

## 9. Where the value has been

Ranked by the owner's own reactions in the record, most valuable first:

1. Buying the right thing at the right size, or not buying (D1, D2, D3). The sock analysis, the blazer sizing, the Clifford verdict, the Bordeaux correction, the completionism rule.
2. The consignment done for him (E2). Twenty-six items, £5,865 listed, about £3,500 expected, his only actions paste and box.
3. Intake and maintenance by email, photo, and sentence (A1 to A4). The ledger exists because of this.
4. Learning and direction (C1, C2, C3). The vocabulary he now uses, the rules he now states.
5. Arguing with the board and dressing for a room (B4, F1).
6. The daily board (B1), the most frequent use and the one he has said never once just worked.
7. Culls and lifecycle (E1, E3), seasonal work (F2), inventory questions (A6).
8. Writing, accessories, storage (C4, D5, E4).

## 10. Where it broke, by family, with root causes

**Family B, the board:** composition happened in the wrong place (a chat session, from memory, in the morning) and at the wrong time; availability was not a hard gate; repair was left to an operator who might not be there; the format lived in three places; standing directions lived in memory. Root cause: a stochastic operator running a deterministic loop.

**Family A4 and A5, ledger integrity:** the same operator wrote values to make boards pass (outerwear ceilings, the 15 oz canvas), invented rows (the Observer, the Avignon), and let duplicates in. Root cause: free-form writes with no invariants.

**Transport:** the connector's authorisation lapsed twice (write scope in August, absent in September), and the only recovery path needed a desktop and a secret he did not hold. Root cause: the daily loop depended on the chat app's authorisation, and the secret was set by a builder rather than the owner.

**Everything else** was occasionally wrong in the way conversations are wrong and corrected in the next sentence. It did not need rebuilding; it needed the ledger to be trustworthy and reachable.

## 11. Requirements derived from the record

Stated so that a design can be checked against them. They are not a design.

**Conversation and ledger access**
- R1. The conversation can create ledger rows from what it reads in an email, a photo, or a sentence, with every field the ledger needs, in one exchange.
- R2. An item can be on order with an expected arrival and contributes nothing until activated.
- R3. Order references, fabric codes, prices, and sizes are stored and never rendered on the board.
- R4. Every write is confirmed by reading back the resulting state; nothing is reported as done that has not been verified.
- R5. Identical garments are one row with a quantity, with per-unit availability.
- R6. Photo work matches against existing rows; logging a wear from an unaided photo identification is not permitted.
- R7. Status changes accept a batch and an idempotency key.
- R8. Item resolution uses the owner's own aliases and is exact; when genuinely ambiguous it presents candidates with distinguishing facts and asks once.
- R9. No verb creates a row as a side effect; creation is its own explicit act.
- R10. Confirmations are terse and free of hedges; the system's own output style is a requirement, not a nicety.
- R11. Cloth and category rules (linen floors, alpaca ceiling, belts without thermal ranges, outerwear ceilings) are constraints the ledger enforces, not values the operator remembers.
- R12. Attributes can be edited in bulk across a category or a query.
- R13. Nothing in the system asserts an inventory or fabric fact that is not in the ledger or on the maker's page.
- R14. Merging two rows moves wear history and aliases; it is explicit.
- R15. Deletion is explicit and instructed; disputed rows are benched and visible.
- R16. One query returns the complete inventory with status and availability, never silently truncated.

**The board**
- R17. Boards are composed on a schedule, in code, from the live ledger and the forecast, and never depend on the chat app being open or connected.
- R18. Availability is a hard gate applied at composition and re-applied on every event that can change it.
- R19. A withdrawn option is replaced in the same operation; a placeholder is not a representable state.
- R20. The thermal rule, the layering rule, the outerwear ceiling, the sock rule, and the footwear-pair rule are code with tests.
- R21. Variety over the week is enforced; within a board, shirts and trousers are distinct.
- R22. Standing directions (boldness, anti-rut, navy, academic blazer) are data the composer reads and a check the board can be tested against.
- R23. The rendered format matches the approved format exactly, from one renderer, on every surface.
- R24. Names on the board are perceptible names.
- R25. Board prose teaches one principle per outfit and contains no operational metadata.
- R26. The board is readable from a plain web page as well as the calendar, so the calendar is a projection, not the only copy.

**Wearing and laundry**
- R27. A wear is logged by option number or by description, from the board page or the conversation, in one message.
- R28. A logged wear is amended by supersession, never edited.
- R29. Logging cascades to every open board immediately and reports what changed.
- R30. Logging and the morning pick work without the chat connector.
- R31. Hamper entries bind to laundry cycles at pickup; entries after pickup wait.
- R32. Two laundry channels: the service and hand-wash, cleared by different events.
- R33. Roles that never launder have no laundry state.

**Steering and conversation about the board**
- R34. Verbs exist to swap one slot, rebuild one option under a brief, and rebuild a day under a brief (occasion, register, formality, must-include, must-exclude), each returning a validated result.
- R35. A brief given for a day carries through any later rebuild of that day.
- R36. A change accepted in conversation lands in the board without a separate step.

**Taste, learning, shopping**
- R37. Every attribute the theory needs is readable by the conversation.
- R38. The board's sentences are produced from the same taste rules the conversation uses.
- R39. Standing directions can be stated in a sentence and stored as data.
- R40. A direction is testable against a board.
- R41. The full ledger and wear history are readable as material for writing and analysis.
- R42. Wear equity and last-worn are queryable per item and per category.
- R43. Palette and attribute queries across categories are available.
- R44. Body measurements and per-maker size verdicts are stored as dated facts.
- R45. Garment measurements can be stored per item.
- R46. A "what would this displace" query answers where a prospective purchase would sit.
- R47. Reminders for drops and windows can be set from the conversation.
- R48. Accessories are ledger items the board can offer.

**Lifecycle**
- R49. A reconcile-against-the-shelf mode lists a category and takes the owner's word for what is there.
- R50. A for-sale state with listing data, distinct from retired.
- R51. The conversation can act on the web (forms, price lookups) on the owner's behalf.
- R52. Benches carry reasons and expected returns, including "at tailor".
- R53. Items have a location.
- R54. The board reads the owner's Google Calendar for the day's shape (office days, walks, lectures, events) at composition, and the calendar is the primary morning surface: the owner reads the board there, not in a chat. Settled 13 Sep 2026.
- R55. Seasonal benches and a "what becomes wearable at N degrees" view.
- R56. Every surface is designed so that the owner's action is the smallest possible one.

**Transport and recovery**
- R57. The conversational surface has full read and write access to the ledger through the constrained verbs above; it is not optional.
- R58. Reconnecting the conversational surface must be possible from a phone in a minute with no secret the owner does not hold.
- R59. Nothing in the daily loop (compose, deliver, pick, log, laundry) depends on the conversational surface being connected.

## 12. What the record does not settle about the design

- Whether five options a day is the right number in winter, when outerwear narrows the space. The approved format says five; the August boards ran five; no winter has been run through the system yet.

Settled 13 Sep 2026: the board reads the owner's Google Calendar for the day's events and office days, and the calendar is the morning surface, chosen precisely so that mornings need no chat (R54).

Ledger state (what is benched, counted, returned, or disputed this week) is data the system holds and is not a design question.
