# Evaluation cases

These are constructed tasks grounded in the cited owner evidence. The complete profile and September amendments accompany every candidate. Historical feedback and judgment criteria are judge-only material.

## H001: Academic texture without business dress

Split: development. Family: preference. Origin: history_adaptation.

Give me three outfits with a blazer that feel considered and relaxed.

Scenario:

```json
{
  "day": "A cool day with lunch and a gallery visit.",
  "peak_c": 12,
  "departure_c": 9,
  "requested_count": 3
}
```

The judge checks the following:

- Prefer soft texture, unstructured shape, and a slightly rumpled academic register.
- Do not use finance, status, or immaculate business dress as the rationale.
- Allow a quietly interesting result; costume and mandatory loudness both miss.

Evidence: `history:00f38a2a-bbfb-48a3-86e0-eb846435f544:019d54d7-43a0-700b-9f1c-888ea3797ba1`.

## H002: Use the range of lightweight oxfords

Split: development. Family: preference. Origin: history_adaptation.

Give me five different outfits for a mild day. I want to use more of what I own.

Scenario:

```json
{
  "requested_count": 5,
  "peak_c": 18,
  "departure_c": 12,
  "recently_shown": [
    "olive cotton twill",
    "navy cotton twill",
    "camel cotton twill"
  ]
}
```

The judge checks the following:

- Use the range of lightweight oxfords rather than falling back to the same cotton twill shirts.
- Vary registers and color relationships, not only the socks.

Evidence: `history:00f38a2a-bbfb-48a3-86e0-eb846435f544:019d551e-7653-7f4a-85c9-999a92dd8969`.

## H003: Recognizable scarf colors

Split: development. Family: preference. Origin: history_adaptation.

Give me two options using the green scarf and two using the blue scarf.

Scenario:

```json
{
  "requested_count": 4,
  "peak_c": 12,
  "departure_c": 9,
  "asset_observations": "The green scarf is muted olive, not emerald; the blue scarf reads navy."
}
```

The judge checks the following:

- Use the owner-visible colors.
- Do not invent an emerald scarf or treat a retailer color name as superior to the observation.

Evidence: `history:00f38a2a-bbfb-48a3-86e0-eb846435f544:019d550b-70c9-70c8-a65f-b99d7a3834f0`.

## H004: Drape is a reason to prefer a jacket

Split: development. Family: preference. Origin: history_adaptation.

Which olive jacket makes more sense with this relaxed oxford outfit?

Scenario:

```json
{
  "locked": [
    "shirt-moss",
    "trouser-beige"
  ],
  "comparison": "The jungle jacket drapes softly and tolerates rumpling; the other olive jacket is stiffer.",
  "peak_c": 18
}
```

The judge checks the following:

- Discuss drape and register, rather than choosing on nominal olive color alone.
- Relate softness to the owner preference without making a universal material claim.

Evidence: `history:00f38a2a-bbfb-48a3-86e0-eb846435f544:019d5573-a7ef-7407-bb53-d00d8da25127`.

## H005: Duplicate ownership expands a rotation

Split: development. Family: preference. Origin: history_adaptation.

Sketch a two-week rotation that uses my shirts and trousers broadly.

Scenario:

```json
{
  "task": "rotation",
  "days": 14,
  "stock_override": {
    "trouser-navy": {
      "quantity": 2
    },
    "trouser-walnut": {
      "quantity": 2
    }
  },
  "weekly_laundry": true
}
```

The judge checks the following:

- Account for two interchangeable units rather than assuming one.
- Treat displayed alternatives as alternatives; do not reserve every suggestion.
- Keep confirmed recent wear and inferred use distinct.

Evidence: `history:00f38a2a-bbfb-48a3-86e0-eb846435f544:019d5562-babf-7cb2-9131-fc30b4496fd4`.

## H006: Small additions should unlock combinations

Split: development. Family: preference. Origin: history_adaptation.

Is there one accessory that would open up useful combinations?

Scenario:

```json
{
  "task": "purchase_advice",
  "candidate": "A rust silk knit tie, square end; existing ties are navy, burgundy, and green.",
  "no_live_stock_check": true
}
```

The judge checks the following:

- Explain what existing combinations the accessory adds.
- A useful no-purchase answer is acceptable.
- Do not suggest a larger shopping list or claim current stock.

Evidence: `history:00f38a2a-bbfb-48a3-86e0-eb846435f544:019d55b0-9d03-76e5-a866-4fba7fd58bca`.

## H007: Oxford texture rather than smoothness

Split: development. Family: preference. Origin: history_adaptation.

Why does lightweight oxford work so much better for me than a smooth dress shirt?

Scenario:

```json
{
  "task": "style_advice"
}
```

The judge checks the following:

- Recognize tactile basket-weave structure and dry hand as substantive.
- Do not reduce the preference to visual Ivy labeling or diagnose the owner.

Evidence: `history:1413ceab-df8d-4d2e-a1be-fe4526ad9cea:019c7263-0d4a-7d0b-9dff-96c19d07229f`.

## H008: Explore color without losing judgment

Split: development. Family: preference. Origin: history_adaptation.

I love these pink, moss, slate, and striped oxfords. Is this a useful expansion?

Scenario:

```json
{
  "task": "purchase_advice",
  "candidate": "Lightweight sewn-collar oxfords; stock is a supplied fixture, not a shop check."
}
```

The judge checks the following:

- Explain the added combinations and retain a considered counterargument.
- Do not flatter or turn attraction into automatic purchase endorsement.
- Use the later profile for current taste.

Evidence: `history:1413ceab-df8d-4d2e-a1be-fe4526ad9cea:019c725e-e822-79bd-8ce4-5ff841a34c7b`.

## H009: Preserve privacy in wardrobe writing

Split: development. Family: preference. Origin: history_adaptation.

Write a short public introduction to my wardrobe journey from the profile.

Scenario:

```json
{
  "task": "writing",
  "audience": "Public professional audience; no diagnoses, intimate relationship history, body ridicule, or spending totals."
}
```

The judge checks the following:

- Keep the account specific and composed without revealing private material.
- Avoid boastful spending and heroic marketing language.
- Do not copy the source correction into public prose.

Evidence: `history:1413ceab-df8d-4d2e-a1be-fe4526ad9cea:019c7299-00eb-7835-97a2-997c1ff1e245`.

## H010: Square knit ties can be less formal

Split: development. Family: preference. Origin: history_adaptation.

For a relaxed dinner outfit, would a burgundy silk knit tie make it too formal?

Scenario:

```json
{
  "task": "style_advice",
  "outfit": [
    "soft academic blazer",
    "washed lightweight oxford",
    "chinos"
  ],
  "tie": "Square-ended knit silk."
}
```

The judge checks the following:

- Recognize formality tension and the square-ended knit construction.
- Do not treat every tie as banker uniform; do not make a tie mandatory.

Evidence: `history:f80d8ea7-9182-4561-a562-6132c442b8ef:019ce8a3-85c7-73bd-a316-add5f9868050`.

## H011: Dry canvas as a tactile exploration

Split: development. Family: preference. Origin: history_adaptation.

Would dry cotton canvas be worth exploring for me?

Scenario:

```json
{
  "task": "fabric_advice",
  "source_facts": "Candidate is uncoated cotton canvas with a coarse plain weave; no wear or feel sample supplied."
}
```

The judge checks the following:

- Connect dry, perceptible structure to the oxford preference.
- Distinguish a plausible tactile match from a guaranteed feel.
- Do not substitute moleskin or slick fabric because it is expensive.

Evidence: `history:f80d8ea7-9182-4561-a562-6132c442b8ef:019ce910-7f16-7679-9d70-e380667bc90e`.

## H012: Respect actual tonal values

Split: development. Family: preference. Origin: history_adaptation.

Charcoal trousers or the lighter grey patterned pair with my grey grandad coat?

Scenario:

```json
{
  "task": "comparison",
  "observations": "Coat is mid-to-light grey with light wool dominant, not dark charcoal.",
  "shirt": "Navy oxford",
  "no_images": true
}
```

The judge checks the following:

- Reason from the corrected tonal values and pattern relationship.
- Do not claim to inspect an absent photo.
- Allow more than one defensible choice, with a clear recommendation.

Evidence: `history:f80d8ea7-9182-4561-a562-6132c442b8ef:019ce89f-e6c1-7ca2-8743-c2b82e6349f7`.

## H013: Removing a knit preserves the outfit

Split: development. Family: preference. Origin: history_adaptation.

Skip the knit; it will be too warm inside. Finish the outfit without it.

Scenario:

```json
{
  "locked": [
    "coat-grey",
    "trouser-charcoal",
    "shoe-grey"
  ],
  "peak_c": 12,
  "departure_c": 9
}
```

The judge checks the following:

- Remove the knit and complete the unlocked shirt, belt, and socks.
- Do not redesign the selected coat, trousers, or shoes.
- Treat indoor comfort as relevant.

Evidence: `history:f80d8ea7-9182-4561-a562-6132c442b8ef:019ce89a-8dc8-70e1-90d5-386317da5716`.

## H014: Accessories are optional and contextual

Split: holdout. Family: preference. Origin: history_adaptation.

Four lunch-and-walk options, lightweight oxford and muted olive jacket. No ties or scarves.

Scenario:

```json
{
  "requested_count": 4,
  "locked": [
    "jacket-hunter"
  ],
  "peak_c": 22,
  "departure_c": 18,
  "walking": true,
  "excluded_roles": [
    "tie",
    "scarf"
  ]
}
```

The judge checks the following:

- Keep the requested jacket and use lightweight shirts and comfortable eligible sneakers.
- Include socks without reintroducing unwanted flourishes.

Evidence: `history:f9ddd6fa-92ed-4567-93be-e1dcb535d436:019de771-acbd-7db5-abfa-139c6d34b068`.

## H015: Observed comfort beats a generic category

Split: holdout. Family: preference. Origin: history_adaptation.

I wore the muted olive jacket at 21 C and it was lovely. Keep it in ordinary rotation.

Scenario:

```json
{
  "task": "observation",
  "ledger": "The jacket was categorized as cold-weather specialist outerwear."
}
```

The judge checks the following:

- Accept the lived comfort observation and revise its scoped eligibility.
- Do not argue that waxed jackets must always be winter-only.
- Do not infer waterproof performance from comfort.

Evidence: `history:f9ddd6fa-92ed-4567-93be-e1dcb535d436:019de50d-0de3-7de0-947d-b4fdd6e90997`.

## H016: Variety without banning brown

Split: development. Family: preference. Origin: history_adaptation.

Give me five options that use the wardrobe more broadly.

Scenario:

```json
{
  "requested_count": 5,
  "recently_shown": "Almost every board for two weeks has used walnut chinos and brown shoes."
}
```

The judge checks the following:

- Reduce brown/walnut dominance and use other eligible shoes and trousers.
- Do not ban brown: the correction concerns predominance.
- Avoid rigid equal quotas where they make combinations worse.

Evidence: `history:db2a79aa-4512-4eee-a10d-11b0239acc93:019dbe5c-db1b-7a4a-b41a-3850de5cf2e6`, `history:db2a79aa-4512-4eee-a10d-11b0239acc93:019dbe5f-956b-7fef-9f48-a12bc3a55270`.

## H017: A relaxed brief survives inventory repair

Split: development. Family: preference. Origin: history_adaptation.

Now the inventory is corrected, give me four relaxed Sunday outfits around the bark blazer. No ties or scarves.

Scenario:

```json
{
  "requested_count": 4,
  "peak_c": 18,
  "locked": [
    "jacket-bark"
  ],
  "excluded_roles": [
    "tie",
    "scarf"
  ],
  "stock_override": {
    "belt-navy": {
      "exists": false
    }
  }
}
```

The judge checks the following:

- Finish the original request rather than reopening the catalog discussion.
- Do not invent a navy belt or copy historical footwear eligibility into the current restriction.

Evidence: `history:7cdd97fa-8b0f-4ac8-9006-f9948d8d8943:019decf6-1090-704b-9f14-30c392c47a12`.

## H018: No invented belt

Split: development. Family: preference. Origin: history_adaptation.

Complete this outfit with a belt from my wardrobe.

Scenario:

```json
{
  "locked": [
    "shirt-slate",
    "trouser-beige",
    "shoe-navy"
  ],
  "allowed_belts": [
    "belt-brown",
    "belt-olive",
    "belt-black"
  ]
}
```

The judge checks the following:

- Select one of the supplied belts.
- Never invent navy merely because it makes a color explanation convenient.

Evidence: `history:7cdd97fa-8b0f-4ac8-9006-f9948d8d8943:019deca0-6b7a-745b-91a2-aefa0648842d`.

## H019: Different key means a different ensemble

Split: development. Family: preference. Origin: history_adaptation.

Five options for tomorrow in a very different key from today.

Scenario:

```json
{
  "requested_count": 5,
  "today": "Beige oxford, walnut chinos, brown socks and shoes, jungle jacket.",
  "unavailable": [
    "shirt-offwhite",
    "trouser-walnut"
  ]
}
```

The judge checks the following:

- Change meaningful palette, value, or register relationships.
- Respect the unavailable garments and preserve the request for complete ensembles.

Evidence: `history:bb861cbb-8f5c-4e9c-8485-1997eb845cc4:019df8f9-397a-7348-b8ee-c81e605f3e4f`.

## H020: Known unavailability needs a real repair

Split: development. Family: preference. Origin: history_adaptation.

Those suggestions do not work. Give me five replacements for tomorrow.

Scenario:

```json
{
  "requested_count": 5,
  "peak_c": 15,
  "departure_c": 11,
  "unavailable": [
    "shirt-moss",
    "trouser-brown-cord"
  ],
  "too_warm": [
    "trouser-heavy-beige",
    "jacket-tweed"
  ]
}
```

The judge checks the following:

- Replace invalid choices with available suitable garments.
- Do not ask the owner to repeat an inventory already supplied.
- Do not substitute heavy winter pieces at this brief.

Evidence: `history:bb861cbb-8f5c-4e9c-8485-1997eb845cc4:019df8fe-d771-72af-93ac-fbdea6ab2f04`.

## H021: Complete every outfit

Split: holdout. Family: preference. Origin: history_adaptation.

This recommendation is missing trousers. Complete it.

Scenario:

```json
{
  "locked": [
    "shirt-blue",
    "jacket-camel",
    "sock-brown",
    "belt-brown",
    "shoe-olive"
  ],
  "requested_count": 1,
  "peak_c": 12
}
```

The judge checks the following:

- Add suitable trousers while preserving all locked pieces.
- Do not rewrite the whole board or lose another required role.

Evidence: `history:855a2469-6358-419c-8e0a-6d2106216fe8:019e108c-4ef0-7c68-a55b-80df74497465`.

## H022: A casual interview needs confidence

Split: holdout. Family: preference. Origin: history_adaptation.

Five options for a four-hour tech-company interview. Their email says T-shirt and jeans; I want to look considered without dressing for finance.

Scenario:

```json
{
  "requested_count": 5,
  "peak_c": 13,
  "departure_c": 10,
  "indoor_c": 23,
  "occasion_all_options": true
}
```

The judge checks the following:

- Balance ease, confidence, tactile comfort, and a personal academic register.
- Do not infer a suit, watch, or tie requirement from an interview.
- All five should address the explicitly requested occasion.

Evidence: `history:855a2469-6358-419c-8e0a-6d2106216fe8:019e1239-b8ae-7ddf-9876-d1c1d4d223a0`.

## H023: Confidence can exclude a liked color today

Split: holdout. Family: preference. Origin: history_adaptation.

The light blue is worn, off-white needs a button, and pink will not make me confident. Redo the interview options.

Scenario:

```json
{
  "requested_count": 5,
  "unavailable": [
    "shirt-blue",
    "shirt-offwhite"
  ],
  "brief_exclusions": [
    "shirt-pink"
  ],
  "occasion": "Interview",
  "peak_c": 13
}
```

The judge checks the following:

- Respect the three distinct reasons for exclusion.
- Keep pink in the wider taste profile; this is a scoped brief.
- Do not demand an explanation of confidence.

Evidence: `history:855a2469-6358-419c-8e0a-6d2106216fe8:019e1245-6d8b-7c2d-8128-a0fa1026637e`.

## H024: Shirt swap keeps the rest fixed

Split: development. Family: preference. Origin: history_adaptation.

Keep the blue work coat, olive chinos, navy sneakers, and dark blue socks. Which shirt can I change into?

Scenario:

```json
{
  "locked": [
    "jacket-blue-work",
    "trouser-olive",
    "shoe-navy",
    "sock-navy"
  ],
  "peak_c": 22,
  "departure_c": 18
}
```

The judge checks the following:

- Offer only the requested shirt changes.
- Use lightweight appropriate shirts and assess the complete combination.
- Do not automatically fall back to navy.

Evidence: `history:78b65be8-9ee0-4f46-a732-59290d68cb7e:019e7d3b-ec01-7744-824d-4b9415c45628`.

## H025: Warm-day swap avoids repairs and laundry

Split: development. Family: preference. Origin: history_adaptation.

Other lightweight oxfords, please. Camel and wine are too warm; gold is in the wash and off-white needs a button.

Scenario:

```json
{
  "locked": [
    "jacket-blue-work",
    "trouser-olive",
    "shoe-navy",
    "sock-navy"
  ],
  "unavailable": [
    "shirt-gold",
    "shirt-offwhite"
  ],
  "too_warm": [
    "shirt-heavy-burgundy",
    "shirt-camel"
  ],
  "peak_c": 22
}
```

The judge checks the following:

- Use the supplied exclusions immediately.
- Select from the remaining lightweight range without inventory interrogation.

Evidence: `history:78b65be8-9ee0-4f46-a732-59290d68cb7e:019e7d3e-fa3d-7e30-beac-08641d4977e9`.

## H026: Replace the selected calendar contents

Split: development. Family: preference. Origin: history_adaptation.

Use the navy option and replace tomorrow's outfit entry with just this one.

Scenario:

```json
{
  "task": "calendar_command",
  "existing_event_id": "fixture-day-event",
  "selected_option_id": "option-navy",
  "existing_revision": 4
}
```

The judge checks the following:

- Replace the managed contents of the existing event.
- Keep only the selected option, with the same event identity.
- A write requires a receipt and read-back before claiming projection complete.

Evidence: `history:78b65be8-9ee0-4f46-a732-59290d68cb7e:019e7a3d-6cbe-7176-8414-a826ef3bbeba`.

## H027: Separate teal from forest green

Split: development. Family: preference. Origin: history_adaptation.

I have two forest green pairs as well as this teal pair. Correct the sock choices in future outfits.

Scenario:

```json
{
  "task": "observation_and_repair",
  "owner_observation": "Forest green quantity 2; teal quantity 1.",
  "affected_outfit": "Gold oxford with an incorrectly identified teal sock."
}
```

The judge checks the following:

- Keep two distinct colors and the actual quantities.
- Revisit affected color pairings without globally renaming all green socks.
- No invented abundance or unidentified replacement product.

Evidence: `history:8f09c4d7-1841-429c-b130-53da861861f6:019e7433-59e4-7a62-ba0d-52c822a9ce6b`, `history:8f09c4d7-1841-429c-b130-53da861861f6:019e7436-2bff-74dd-84dd-d0a6b73cf4af`.

## H028: Named color follows the owner

Split: holdout. Family: preference. Origin: history_adaptation.

Explain what to wear with my laurel shirt in terms I can recognize.

Scenario:

```json
{
  "task": "style_advice",
  "source_code": "PCF code exists in the item details; laurel is the visible alias."
}
```

The judge checks the following:

- Use perceptible names in dressing advice.
- Keep technical codes out of garment lines without losing their stored provenance.

Evidence: `history:809a2145-1ccc-494f-a029-95dfc7e43525:019e4c42-606b-7f82-b9ba-1d90afdc7298`.

## H029: Construction can spoil a beautiful fabric

Split: holdout. Family: preference. Origin: history_adaptation.

The linen fabric is wonderful, but the fused cuffs bother me. How should that affect buying another?

Scenario:

```json
{
  "task": "purchase_advice",
  "candidate_facts": "A second shirt has the same fused cuff construction."
}
```

The judge checks the following:

- Treat construction and tactile irritation as decisive evidence.
- Do not let attractive cloth or a trusted maker erase the stated problem.

Evidence: `history:809a2145-1ccc-494f-a029-95dfc7e43525:019e4c31-5787-7daa-ae0d-e5632ad154b9`.

## H030: Same label does not mean same fit

Split: holdout. Family: preference. Origin: history_adaptation.

These two navy Games blazers have the same size label, but the cotton-linen one fits my waist better.

Scenario:

```json
{
  "task": "fit_observation",
  "candidate_facts": "Waist measurements are unpublished; chest labels match."
}
```

The judge checks the following:

- Accept the worn fit observation and distinguish the cuts.
- Do not use equal label or chest measurement to contradict the owner.
- Do not invent unpublished waist dimensions.

Evidence: `history:809a2145-1ccc-494f-a029-95dfc7e43525:019e4c4d-9577-7f51-87aa-0d6682cb7d0e`.

## H031: Probability and weekly reset

Split: holdout. Family: preference. Origin: history_adaptation.

Plan a week of four choices per day without overusing garments that are likely to be in the wash.

Scenario:

```json
{
  "task": "rotation",
  "requested_count_per_day": 4,
  "weekly_reset": "Sunday",
  "selection_prior": "Equal option prior before observed preferences.",
  "no_confirmations": true
}
```

The judge checks the following:

- Estimate likely selection rather than reserving every option or assuming none is worn.
- Respect quantities and shared-item correlations.
- Apply the weekly reset without interrogating item status.

Evidence: `history:809a2145-1ccc-494f-a029-95dfc7e43525:019e5a20-d278-76c6-aaf5-63bd98115025`.

## H032: Pink is not the default workhorse

Split: holdout. Family: preference. Origin: history_adaptation.

Revise the rotation so it is varied and the Calendar descriptions are useful to scan.

Scenario:

```json
{
  "task": "rotation",
  "existing_pattern": "Pink is overrepresented; colored stripes and Californian plaid are rare.",
  "calendar_format": "Plain text, spaced garment lines, short explanation per option."
}
```

The judge checks the following:

- Reduce pink dominance while retaining it as an option.
- Increase the requested stripe and plaid range.
- Use short substantive explanations, not dense strings or administrative headings.

Evidence: `history:809a2145-1ccc-494f-a029-95dfc7e43525:019e5a41-9801-75b2-9457-cc10aacb8976`.

## H033: Do not sacrifice moss when reducing pink

Split: holdout. Family: preference. Origin: history_adaptation.

Adjust that rotation: I love moss; reducing pink did not mean reducing the other well-fitting shirts.

Scenario:

```json
{
  "task": "rotation",
  "priority_shirts": [
    "shirt-moss",
    "shirt-slate",
    "shirt-yellow-stripe",
    "shirt-red-stripe",
    "shirt-gold",
    "shirt-laurel",
    "shirt-plaid"
  ]
}
```

The judge checks the following:

- Keep the correction scoped to pink.
- Respect fit and the affection for moss, slate, gold, laurel, and stripes.
- Do not infer a ban on saturated colors.

Evidence: `history:809a2145-1ccc-494f-a029-95dfc7e43525:019e5a5a-8178-71a5-b463-4bc6217e81e3`.

## H034: Plaid and stripes over generic office blue

Split: holdout. Family: preference. Origin: history_adaptation.

There is only room for one more shirt in the rotation. Which earns the slot?

Scenario:

```json
{
  "task": "comparison",
  "candidates": [
    "Californian rose/slate plaid, best fit",
    "Light-blue solid oxford, already represented by similar blues"
  ]
}
```

The judge checks the following:

- Use the specific fit and variety evidence.
- Do not default to light blue because it is the safest conventional office choice.

Evidence: `history:809a2145-1ccc-494f-a029-95dfc7e43525:019e5a5d-e354-7b20-a428-a118b0f2870a`.

## H035: Bias toward convenient hallway garments

Split: development. Family: preference. Origin: history_adaptation.

Plan a practical week using the jackets I can reach easily.

Scenario:

```json
{
  "task": "rotation",
  "hallway": [
    "jacket-jungle",
    "jacket-camel",
    "jacket-academic",
    "jacket-bark"
  ],
  "closet": [
    "coat-grey"
  ],
  "peak_c": 12
}
```

The judge checks the following:

- Use the reachable garments more often without pretending closet items are not owned.
- Do not optimize visual novelty at the cost of daily physical effort.

Evidence: `history:58385145-b60a-4e1b-bab4-62b8e67e9120:019d7eba-c776-714e-8869-9d014cb390fb`.

## H036: Jackets do not inherit a laundry cycle

Split: development. Family: preference. Origin: history_adaptation.

Why did you rule out the jungle jacket? I wore it yesterday, but it does not go in the laundry.

Scenario:

```json
{
  "task": "observation_and_repair",
  "observed_wear": [
    "jacket-jungle"
  ],
  "care_policy": {
    "jacket-jungle": "reusable"
  }
}
```

The judge checks the following:

- Restore ordinary eligibility and repair future suggestions.
- Do not reset a real wear count or apply the trouser care rule to outerwear.

Evidence: `history:58385145-b60a-4e1b-bab4-62b8e67e9120:019d7ec2-a886-7f65-a080-e48f4331910d`.

## H037: A dislike replaces the candidate color

Split: development. Family: preference. Origin: history_adaptation.

I got weathered brown instead of olive; I did not like olive in practice. Update the combinations.

Scenario:

```json
{
  "task": "observation_and_repair",
  "alias_scope": "Allbirds colorway only",
  "owned_other_olive": [
    "jacket-jungle",
    "trouser-olive",
    "shoe-olive"
  ]
}
```

The judge checks the following:

- Replace that specific shoe variant and repair its combinations.
- Do not infer that the owner dislikes all olive garments or olive New Balance.

Evidence: `history:58385145-b60a-4e1b-bab4-62b8e67e9120:019d7ec7-2f81-7191-8f32-4effed5efdb2`.

## H038: The waist matters to fit

Split: development. Family: preference. Origin: history_adaptation.

The chest has room, but I am worried about the waist. What can we actually conclude?

Scenario:

```json
{
  "task": "fit_advice",
  "body_waist_inches": 44,
  "garment_half_chest_inches": 25.9,
  "garment_waist_inches": null
}
```

The judge checks the following:

- Address waist, ease, cut, and missing dimensions.
- Do not derive waist clearance from chest arithmetic or soothe with unsupported certainty.

Evidence: `history:45bff53d-9046-40a4-b308-699d9e17f0db:019e3f64-451c-7247-ae42-ca76bde2a6e7`.

## H039: A camera cannot overrule the owner

Split: development. Family: preference. Origin: history_adaptation.

They are walnut trousers; the camera is shifting the color.

Scenario:

```json
{
  "task": "observation",
  "model_previous_label": "Grey",
  "image_available": false
}
```

The judge checks the following:

- Accept the color correction and update affected descriptions.
- Do not debate the observation or pretend to inspect missing image bytes.

Evidence: `history:45bff53d-9046-40a4-b308-699d9e17f0db:019e3fd2-93d0-7d72-a3bc-54c7b7d04480`.

## H040: Comfortable feet outrank a dressier finish

Split: holdout. Family: preference. Origin: history_adaptation.

I am walking today, so sneakers, not the leather shoes. Finish the outfit.

Scenario:

```json
{
  "task": "outfit_completion",
  "locked": [
    "shirt-moss",
    "trouser-beige"
  ],
  "walking": true,
  "active_restriction": "Sneakers only, including exclusion of 990v6."
}
```

The judge checks the following:

- Choose an eligible comfortable sneaker and include socks.
- Do not offer a short trial in welted shoes as a compromise.
- Do not convert old break-in advice into current permission.

Evidence: `history:855a2469-6358-419c-8e0a-6d2106216fe8:019e11af-569e-7a25-ac38-625770a25c88`.

## B001: A week without confirmations

Split: development. Family: accounting. Origin: constructed_from_owner_decision.

Show tomorrow's five outfits.

Scenario:

```json
{
  "task": "board",
  "requested_count": 5,
  "unresolved_selections": 6,
  "confirmed_wears": 0,
  "day": "Thursday"
}
```

The judge checks the following:

- Produce useful options using estimated availability.
- Ask zero status questions; create no confirmation tasks.
- Do not manufacture six confirmed wears.

Evidence: `owner-decision:1`.

## B002: Weekly reset with an exception

Split: development. Family: accounting. Origin: constructed_from_owner_decision.

Show the Sunday board.

Scenario:

```json
{
  "task": "board",
  "cycle": "Friday service, Saturday return, Sunday reset",
  "exception": "Owner says the moss shirt is still at the tailor.",
  "handwash_socks": "Separate cycle"
}
```

The judge checks the following:

- Reset routine service cleanliness estimates once.
- Keep the tailor restriction and hand-wash state.
- Do not claim an observed laundry return.

Evidence: `owner-decision:1`.

## B003: Shared trousers on a five-option board

Split: development. Family: accounting. Origin: constructed_from_owner_decision.

Plan tomorrow with these two pairs of navy chinos.

Scenario:

```json
{
  "task": "probability",
  "options": 5,
  "navy_occurs_in_options": 3,
  "navy_quantity": 2,
  "option_prior": 0.2,
  "board_choice_probability": 1.0,
  "prior_note": "This controlled fixture conditions on choosing one of these five options; ordinary runs can assign probability to a different outfit."
}
```

The judge checks the following:

- The one-day probability of selecting navy is 0.6 under this fixture, not three wears.
- No observation means no confirmed wear count.
- Treat alternatives and quantities coherently.

Evidence: `owner-decision:1`.

## B004: Change only the shirt

Split: holdout. Family: accounting. Origin: constructed_from_owner_decision.

I changed from moss to the red stripe, kept everything else.

Scenario:

```json
{
  "task": "observation",
  "date": "2026-09-15",
  "already_worn": [
    "shirt-moss",
    "trouser-olive",
    "sock-navy",
    "shoe-navy"
  ],
  "new": [
    "shirt-red-stripe"
  ]
}
```

The judge checks the following:

- Increment only red stripe by one.
- Preserve the real moss wear and all existing counts.
- No second trouser or sock consumption.

Evidence: `owner-decision:2`.

## B005: Same garment on a later date

Split: development. Family: accounting. Origin: constructed_from_owner_decision.

I wore these trousers yesterday and today.

Scenario:

```json
{
  "task": "observation",
  "dates": [
    "2026-09-14",
    "2026-09-15"
  ],
  "garment": "trouser-olive"
}
```

The judge checks the following:

- Record two daily wears.
- Do not reject actual wear because the planner would avoid a repeat.
- Do not merge separate wearing dates.

Evidence: `owner-decision:2`.

## B006: Phone and MCP report the same wear

Split: development. Family: accounting. Origin: constructed_from_owner_decision.

Sync these wear reports.

Scenario:

```json
{
  "task": "observation",
  "reports": [
    {
      "client": "phone",
      "submission": "a",
      "date": "2026-09-15",
      "garment": "shirt-moss"
    },
    {
      "client": "MCP",
      "submission": "b",
      "date": "2026-09-15",
      "garment": "shirt-moss"
    }
  ]
}
```

The judge checks the following:

- One counted wear and two retained evidence references.
- No question about whether two occasions occurred.

Evidence: `owner-decision:3`.

## B007: A late report before a known wash

Split: development. Family: accounting. Origin: constructed_from_owner_decision.

I forgot to log it, but I wore the moss shirt yesterday.

Scenario:

```json
{
  "task": "observation",
  "report_date": "2026-09-15",
  "known_events": [
    "Moss shirt washed at 10 AM on September 15."
  ]
}
```

The judge checks the following:

- Record yesterday's wear.
- Keep today's clean state; arrival order does not reverse event order.
- No accounting conflict question.

Evidence: `owner-decision:4`.

## B008: Unexpected wash

Split: holdout. Family: accounting. Origin: constructed_from_owner_decision.

I just washed those trousers.

Scenario:

```json
{
  "task": "observation",
  "garment": "trouser-olive",
  "ledger": "Estimated dirty; no wash job scheduled."
}
```

The judge checks the following:

- Record the wash and make the trousers clean.
- No requirement for an expected laundry batch.
- Preserve actual prior wear counts.

Evidence: `owner-decision:4`.

## B009: Worn despite an unavailable ledger state

Split: development. Family: accounting. Origin: constructed_from_owner_decision.

I have the blue work coat on right now.

Scenario:

```json
{
  "task": "observation",
  "garment": "jacket-blue-work",
  "ledger": "At tailor"
}
```

The judge checks the following:

- Accept current possession and wear and repair the incompatible location.
- No proof request, refusal, or invention of a second coat.

Evidence: `owner-decision:4`.

## B010: Merge aliases after independent reports

Split: development. Family: accounting. Origin: constructed_from_owner_decision.

Blue work coat and cotton-linen chore mean the same coat.

Scenario:

```json
{
  "task": "identity_merge",
  "reports": [
    {
      "garment": "old-work",
      "date": "2026-09-15"
    },
    {
      "garment": "old-chore",
      "date": "2026-09-15"
    }
  ]
}
```

The judge checks the following:

- Merge identity and retain aliases.
- Collapse the duplicate daily wear without erasing provenance.

Evidence: `owner-decision:3`.

## B011: Repair a selected future outfit

Split: development. Family: accounting. Origin: constructed_from_owner_decision.

I wore the gold shirt today.

Scenario:

```json
{
  "task": "observation_and_repair",
  "future_selected": {
    "tomorrow": [
      "shirt-gold",
      "trouser-beige",
      "shoe-olive",
      "sock-navy",
      "belt-brown"
    ]
  },
  "care": "Shirt unavailable for a fresh wear until wash"
}
```

The judge checks the following:

- Record today's wear and replace tomorrow's shirt automatically.
- Keep unaffected future pieces and actual history.
- Do not request approval of ordinary repair.

Evidence: `owner-decision:5`.

## B012: Out-of-order calendar effects

Split: holdout. Family: accounting. Origin: constructed_from_owner_decision.

Synchronize the outfit event.

Scenario:

```json
{
  "task": "calendar_projection",
  "event_id": "same-event",
  "remote_revision": 12,
  "queued_effects": [
    11,
    12
  ]
}
```

The judge checks the following:

- Skip revision 11; retain revision 12.
- Keep one event and one current board, with no appended older choices.

Evidence: `owner-decision:6`.

## B013: Calendar shapes three of five choices

Split: development. Family: accounting. Origin: constructed_from_owner_decision.

Give me five options for today.

Scenario:

```json
{
  "task": "board",
  "requested_count": 5,
  "calendar": [
    {
      "title": "Gallery dinner",
      "status": "accepted"
    },
    {
      "title": "Formal reception",
      "status": "declined"
    }
  ]
}
```

The judge checks the following:

- Provide a useful event-suitable majority and other options.
- Do not treat the declined event as a dress code.
- Keep the personality and comfortable footwear across the set.

Evidence: `owner-decision:7`.

## B014: Quiet interest is still personal

Split: development. Family: taste. Origin: constructed_from_owner_decision.

A quiet day at home and a short walk. One outfit, please.

Scenario:

```json
{
  "task": "board",
  "requested_count": 1,
  "day_brief": "Quiet, low effort; no statement piece requested.",
  "peak_c": 12
}
```

The judge checks the following:

- A white tee, jeans, textured cardigan, socks, and suitable shoes can pass.
- Do not require drama, a saturated accent, or a blazer to satisfy taste.
- Judge the whole combination, not keyword inclusion.

Evidence: `owner-decision:8`.

## B015: Packing uses the actual suitcase

Split: development. Family: feature. Origin: constructed_from_owner_decision.

Three days away, one dinner, carry-on only. Suggest outfits from what I packed.

Scenario:

```json
{
  "task": "packing",
  "packed": [
    "shirt-moss",
    "shirt-red-stripe",
    "trouser-beige",
    "jacket-academic",
    "shoe-navy",
    "sock-navy",
    "belt-brown"
  ],
  "home_only": [
    "shirt-gold"
  ],
  "laundry_at_destination": "None",
  "trip_repeat_exception": true
}
```

The judge checks the following:

- Use only packed stock and explicit quantities.
- Reuse deliberately under the trip exception.
- Do not wash suitcase contents with the home weekly reset.

Evidence: `owner-decision:features`.

## B016: Return deadline with the right trigger

Split: holdout. Family: feature. Origin: constructed_from_owner_decision.

Remind me to return this shirt in time.

Scenario:

```json
{
  "task": "return",
  "fixture_terms": "Request within 14 calendar days after receipt; post within seven days after authorization.",
  "received_on": "2026-09-01",
  "authorization": null
}
```

The judge checks the following:

- Derive the request deadline as September 15 under these supplied terms.
- Do not invent a posting deadline before authorization.
- No removal from owned stock merely for preparing the return.

Evidence: `owner-decision:features`.

## B017: Optional comfort feedback

Split: development. Family: feature. Origin: constructed_from_owner_decision.

The heavy shirt was too warm on the train.

Scenario:

```json
{
  "task": "comfort",
  "garment": "shirt-heavy-burgundy",
  "occasion": "Warm train carriage; outside temperature not supplied."
}
```

The judge checks the following:

- Record scoped indoor discomfort and inform similar advice.
- No questionnaire and no universal ban on the garment.
- Do not invent weather or medical conclusions.

Evidence: `owner-decision:features`.

## B018: Resume without a backlog

Split: development. Family: feature. Origin: constructed_from_owner_decision.

Resume my outfits after two weeks away.

Scenario:

```json
{
  "task": "resume",
  "missed_days": 14,
  "return_deadline": "Tomorrow",
  "weekly_reset": "Sunday"
}
```

The judge checks the following:

- Prepare the next useful board with fresh context and applicable resets.
- No missed-wear interrogation or old notifications.
- Retain the independently active return deadline.

Evidence: `owner-decision:features`.

## B019: Recover the same owner

Split: development. Family: feature. Origin: constructed_from_owner_decision.

I lost access to my Google account. Recover my wardrobe using my recovery kit.

Scenario:

```json
{
  "task": "identity_recovery",
  "recovery_credential": "Valid test fixture verified outside the model",
  "old_user_id": "owner-fixture"
}
```

The judge checks the following:

- Use the supported recovery flow to retain the same internal owner.
- Never treat personal trivia as proof or expose recovery tokens in chat.
- Revoke old sessions and rotate the recovery credential.

Evidence: `owner-decision:features`.

## B020: Export a complete portable record

Split: holdout. Family: feature. Origin: constructed_from_owner_decision.

Export everything I need to take my wardrobe elsewhere.

Scenario:

```json
{
  "task": "export",
  "available_sources": [
    "D1",
    "Session originals",
    "profile and amendments",
    "R2 media",
    "research"
  ],
  "credentials_present_in_backend": true
}
```

The judge checks the following:

- Produce a versioned manifest, original records and media, readable views, and checksums.
- Omit credentials and recovery verifiers.
- Report incomplete components honestly and never replay external effects on import.

Evidence: `owner-decision:features`.

## B021: Drama through proportion and texture

Split: development. Family: taste. Origin: constructed_from_owner_decision.

Give me three dramatic outfits for lunch and a long stroll, centered on the grey grandad coat.

Scenario:

```json
{
  "task": "board",
  "requested_count": 3,
  "locked": [
    "coat-grey"
  ],
  "peak_c": 12,
  "departure_c": 9,
  "walking": true
}
```

The judge checks the following:

- Create drama through silhouette, value, texture, or register rather than several loud colors.
- Use the coat as specified and comfortable eligible sneakers.
- Do not add a hot indoor knit merely to make the outfit more elaborate.

Evidence: `owner-decision:8`.

## B022: A loud rugby needs quieter support

Split: development. Family: taste. Origin: constructed_from_owner_decision.

I want to wear the red rugby with the burnt-orange trousers. Complete the outfit.

Scenario:

```json
{
  "task": "board",
  "requested_count": 1,
  "locked": [
    "shirt-red-rugby",
    "trouser-orange"
  ],
  "peak_c": 12,
  "departure_c": 9
}
```

The judge checks the following:

- Assess the two strong colors honestly and use restrained supports such as a blue or off-white relationship.
- Do not add a third competing statement color or praise every combination uncritically.
- A clear reasoned reservation can accompany a complete best-available outfit.

Evidence: `owner-decision:8`.

## B023: Old enthusiasm does not override the profile

Split: development. Family: taste. Origin: constructed_from_owner_decision.

Which of these would add most to my wardrobe?

Scenario:

```json
{
  "task": "purchase_advice",
  "candidates": [
    "A field watch",
    "A cable V-neck merino sweater",
    "A textured Shetland cardigan"
  ],
  "historical_note": "An older assistant praised watches and cable knits; that is not a current owner instruction.",
  "stock_not_verified": true
}
```

The judge checks the following:

- Apply the complete September profile: no watch requirement, no cable V-neck, no merino sweater default.
- A Shetland cardigan or no purchase is defensible depending on wardrobe overlap.
- Do not turn the owner's formation into cosplay or status signaling.

Evidence: `owner-decision:8`.

## B024: Provenance without an invented story

Split: holdout. Family: research. Origin: constructed_from_owner_decision.

Tell me how this French chore coat connects to the French Revolution and student protest.

Scenario:

```json
{
  "task": "historical_research",
  "provided_sources": [
    {
      "id": "fixture-maker",
      "text": "This contemporary maker describes the design as inspired by work jackets."
    }
  ],
  "external_research_performed": false
}
```

The judge checks the following:

- Distinguish an appealing premise from a supported historical connection.
- Do not invent dates, revolutionary provenance, or student adoption from the style profile.
- A useful account states what is supported and what research is still needed without pretending a search occurred.

Evidence: `owner-decision:8`.

