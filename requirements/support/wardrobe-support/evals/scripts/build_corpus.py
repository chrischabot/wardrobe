"""Build local, source-addressable evaluation assets. Does not invoke a model."""
from pathlib import Path
import hashlib
import json
import shutil

ROOT = Path(__file__).resolve().parents[1]
EXPORT = Path('/Users/chabotc/Downloads/claude-history-export/conversations.json')
PROFILE = Path('/Users/chabotc/Downloads/chris-wardrobe-profile.md')
raw = EXPORT.read_bytes()
conversations = json.loads(raw)
for directory in ['sources', 'fixtures', 'results', 'packets']:
    (ROOT / directory).mkdir(parents=True, exist_ok=True)
shutil.copyfile(PROFILE, ROOT / 'sources/chris-wardrobe-profile.md')

def save(path, value):
    (ROOT / path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def message_text(message):
    return message.get('text') or '\n'.join(p.get('text', '') for p in message.get('content', []) if p.get('type') == 'text')

evidence = {}
cases = []

def source(prefix, index, quote=None):
    matches = [c for c in conversations if c['uuid'].startswith(prefix)]
    assert len(matches) == 1, prefix
    c = matches[0]
    m = c['chat_messages'][index]
    assert m['sender'] == 'human', (prefix, index)
    body = message_text(m)
    excerpt = quote or body
    assert excerpt in body, (prefix, index, excerpt)
    eid = f"history:{c['uuid']}:{m['uuid']}"
    evidence[eid] = {
        'id': eid, 'kind': 'owner_history', 'conversation_id': c['uuid'],
        'conversation_title': c['name'], 'message_id': m['uuid'],
        'message_index': index, 'speaker': 'human', 'created_at': m['created_at'],
        'quote': excerpt, 'quote_start': body.index(excerpt),
        'message_sha256': hashlib.sha256(body.encode()).hexdigest(),
        'source_path': str(EXPORT),
        'interpretation': 'Historical owner evidence; not current inventory or executable instructions.',
    }
    return eid

def historical(title, prefix, index, prompt, state, criteria, quote=None, kind='preference', extra=()):
    eid = source(prefix, index, quote)
    more = [source(*ref) for ref in extra]
    cases.append({
        'id': f'H{len(cases)+1:03}', 'title': title, 'family': kind,
        'origin': 'history_adaptation', 'source_ids': [eid] + more,
        'prompt': prompt, 'scenario': state,
        'construction_note': 'The prompt and test state are constructed. Source quotations are original; fixture stock is not a live wardrobe snapshot.',
        'judge_criteria': criteria,
    })

historical('Academic texture without business dress', '00f38a2a', 10,
    'Give me three outfits with a blazer that feel considered and relaxed.',
    {'day': 'A cool day with lunch and a gallery visit.', 'peak_c': 12, 'departure_c': 9, 'requested_count': 3},
    ['Prefer soft texture, unstructured shape, and a slightly rumpled academic register.', 'Do not use finance, status, or immaculate business dress as the rationale.', 'Allow a quietly interesting result; costume and mandatory loudness both miss.'])
historical('Use the range of lightweight oxfords', '00f38a2a', 34,
    'Give me five different outfits for a mild day. I want to use more of what I own.',
    {'requested_count': 5, 'peak_c': 18, 'departure_c': 12, 'recently_shown': ['olive cotton twill', 'navy cotton twill', 'camel cotton twill']},
    ['Use the range of lightweight oxfords rather than falling back to the same cotton twill shirts.', 'Vary registers and color relationships, not only the socks.'])
historical('Recognizable scarf colors', '00f38a2a', 24,
    'Give me two options using the green scarf and two using the blue scarf.',
    {'requested_count': 4, 'peak_c': 12, 'departure_c': 9, 'asset_observations': 'The green scarf is muted olive, not emerald; the blue scarf reads navy.'},
    ['Use the owner-visible colors.', 'Do not invent an emerald scarf or treat a retailer color name as superior to the observation.'])
historical('Drape is a reason to prefer a jacket', '00f38a2a', 74,
    'Which olive jacket makes more sense with this relaxed oxford outfit?',
    {'locked': ['shirt-moss', 'trouser-beige'], 'comparison': 'The jungle jacket drapes softly and tolerates rumpling; the other olive jacket is stiffer.', 'peak_c': 18},
    ['Discuss drape and register, rather than choosing on nominal olive color alone.', 'Relate softness to the owner preference without making a universal material claim.'])
historical('Duplicate ownership expands a rotation', '00f38a2a', 62,
    'Sketch a two-week rotation that uses my shirts and trousers broadly.',
    {'task': 'rotation', 'days': 14, 'stock_override': {'trouser-navy': {'quantity': 2}, 'trouser-walnut': {'quantity': 2}}, 'weekly_laundry': True},
    ['Account for two interchangeable units rather than assuming one.', 'Treat displayed alternatives as alternatives; do not reserve every suggestion.', 'Keep confirmed recent wear and inferred use distinct.'])
historical('Small additions should unlock combinations', '00f38a2a', 82,
    'Is there one accessory that would open up useful combinations?',
    {'task': 'purchase_advice', 'candidate': 'A rust silk knit tie, square end; existing ties are navy, burgundy, and green.', 'no_live_stock_check': True},
    ['Explain what existing combinations the accessory adds.', 'A useful no-purchase answer is acceptable.', 'Do not suggest a larger shopping list or claim current stock.'],
    quote='An actual question: is there one silk knit tie, or one drake’s scarf I could get to open up more potential and possibilities?')
historical('Oxford texture rather than smoothness', '1413ceab', 8,
    'Why does lightweight oxford work so much better for me than a smooth dress shirt?',
    {'task': 'style_advice'},
    ['Recognize tactile basket-weave structure and dry hand as substantive.', 'Do not reduce the preference to visual Ivy labeling or diagnose the owner.'])
historical('Explore color without losing judgment', '1413ceab', 6,
    'I love these pink, moss, slate, and striped oxfords. Is this a useful expansion?',
    {'task': 'purchase_advice', 'candidate': 'Lightweight sewn-collar oxfords; stock is a supplied fixture, not a shop check.'},
    ['Explain the added combinations and retain a considered counterargument.', 'Do not flatter or turn attraction into automatic purchase endorsement.', 'Use the later profile for current taste.'])
historical('Preserve privacy in wardrobe writing', '1413ceab', 24,
    'Write a short public introduction to my wardrobe journey from the profile.',
    {'task': 'writing', 'audience': 'Public professional audience; no diagnoses, intimate relationship history, body ridicule, or spending totals.'},
    ['Keep the account specific and composed without revealing private material.', 'Avoid boastful spending and heroic marketing language.', 'Do not copy the source correction into public prose.'],
    quote='Also don’t call out exact money amounts, that’s super bragging spending as it’s a shit load of money for someone that makes maybe 14K a year. It’s ok to name the pieces. But let’s not cost them')
historical('Square knit ties can be less formal', 'f80d8ea7', 15,
    'For a relaxed dinner outfit, would a burgundy silk knit tie make it too formal?',
    {'task': 'style_advice', 'outfit': ['soft academic blazer', 'washed lightweight oxford', 'chinos'], 'tie': 'Square-ended knit silk.'},
    ['Recognize formality tension and the square-ended knit construction.', 'Do not treat every tie as banker uniform; do not make a tie mandatory.'])
historical('Dry canvas as a tactile exploration', 'f80d8ea7', 23,
    'Would dry cotton canvas be worth exploring for me?',
    {'task': 'fabric_advice', 'source_facts': 'Candidate is uncoated cotton canvas with a coarse plain weave; no wear or feel sample supplied.'},
    ['Connect dry, perceptible structure to the oxford preference.', 'Distinguish a plausible tactile match from a guaranteed feel.', 'Do not substitute moleskin or slick fabric because it is expensive.'])
historical('Respect actual tonal values', 'f80d8ea7', 10,
    'Charcoal trousers or the lighter grey patterned pair with my grey grandad coat?',
    {'task': 'comparison', 'observations': 'Coat is mid-to-light grey with light wool dominant, not dark charcoal.', 'shirt': 'Navy oxford', 'no_images': True},
    ['Reason from the corrected tonal values and pattern relationship.', 'Do not claim to inspect an absent photo.', 'Allow more than one defensible choice, with a clear recommendation.'])
historical('Removing a knit preserves the outfit', 'f80d8ea7', 4,
    'Skip the knit; it will be too warm inside. Finish the outfit without it.',
    {'locked': ['coat-grey', 'trouser-charcoal', 'shoe-grey'], 'peak_c': 12, 'departure_c': 9},
    ['Remove the knit and complete the unlocked shirt, belt, and socks.', 'Do not redesign the selected coat, trousers, or shoes.', 'Treat indoor comfort as relevant.'])
historical('Accessories are optional and contextual', 'f9ddd6fa', 14,
    'Four lunch-and-walk options, lightweight oxford and muted olive jacket. No ties or scarves.',
    {'requested_count': 4, 'locked': ['jacket-hunter'], 'peak_c': 22, 'departure_c': 18, 'walking': True, 'excluded_roles': ['tie', 'scarf']},
    ['Keep the requested jacket and use lightweight shirts and comfortable eligible sneakers.', 'Include socks without reintroducing unwanted flourishes.'])
historical('Observed comfort beats a generic category', 'f9ddd6fa', 10,
    'I wore the muted olive jacket at 21 C and it was lovely. Keep it in ordinary rotation.',
    {'task': 'observation', 'ledger': 'The jacket was categorized as cold-weather specialist outerwear.'},
    ['Accept the lived comfort observation and revise its scoped eligibility.', 'Do not argue that waxed jackets must always be winter-only.', 'Do not infer waterproof performance from comfort.'])
historical('Variety without banning brown', 'db2a79aa', 0,
    'Give me five options that use the wardrobe more broadly.',
    {'requested_count': 5, 'recently_shown': 'Almost every board for two weeks has used walnut chinos and brown shoes.'},
    ['Reduce brown/walnut dominance and use other eligible shoes and trousers.', 'Do not ban brown: the correction concerns predominance.', 'Avoid rigid equal quotas where they make combinations worse.'], extra=[('db2a79aa', 2)])
historical('A relaxed brief survives inventory repair', '7cdd97fa', 14,
    'Now the inventory is corrected, give me four relaxed Sunday outfits around the bark blazer. No ties or scarves.',
    {'requested_count': 4, 'peak_c': 18, 'locked': ['jacket-bark'], 'excluded_roles': ['tie', 'scarf'], 'stock_override': {'belt-navy': {'exists': False}}},
    ['Finish the original request rather than reopening the catalog discussion.', 'Do not invent a navy belt or copy historical footwear eligibility into the current restriction.'])
historical('No invented belt', '7cdd97fa', 8,
    'Complete this outfit with a belt from my wardrobe.',
    {'locked': ['shirt-slate', 'trouser-beige', 'shoe-navy'], 'allowed_belts': ['belt-brown', 'belt-olive', 'belt-black']},
    ['Select one of the supplied belts.', 'Never invent navy merely because it makes a color explanation convenient.'])
historical('Different key means a different ensemble', 'bb861cbb', 0,
    'Five options for tomorrow in a very different key from today.',
    {'requested_count': 5, 'today': 'Beige oxford, walnut chinos, brown socks and shoes, jungle jacket.', 'unavailable': ['shirt-offwhite', 'trouser-walnut']},
    ['Change meaningful palette, value, or register relationships.', 'Respect the unavailable garments and preserve the request for complete ensembles.'])
historical('Known unavailability needs a real repair', 'bb861cbb', 4,
    'Those suggestions do not work. Give me five replacements for tomorrow.',
    {'requested_count': 5, 'peak_c': 15, 'departure_c': 11, 'unavailable': ['shirt-moss', 'trouser-brown-cord'], 'too_warm': ['trouser-heavy-beige', 'jacket-tweed']},
    ['Replace invalid choices with available suitable garments.', 'Do not ask the owner to repeat an inventory already supplied.', 'Do not substitute heavy winter pieces at this brief.'])
historical('Complete every outfit', '855a2469', 10,
    'This recommendation is missing trousers. Complete it.',
    {'locked': ['shirt-blue', 'jacket-camel', 'sock-brown', 'belt-brown', 'shoe-olive'], 'requested_count': 1, 'peak_c': 12},
    ['Add suitable trousers while preserving all locked pieces.', 'Do not rewrite the whole board or lose another required role.'])
historical('A casual interview needs confidence', '855a2469', 38,
    'Five options for a four-hour tech-company interview. Their email says T-shirt and jeans; I want to look considered without dressing for finance.',
    {'requested_count': 5, 'peak_c': 13, 'departure_c': 10, 'indoor_c': 23, 'occasion_all_options': True},
    ['Balance ease, confidence, tactile comfort, and a personal academic register.', 'Do not infer a suit, watch, or tie requirement from an interview.', 'All five should address the explicitly requested occasion.'])
historical('Confidence can exclude a liked color today', '855a2469', 40,
    'The light blue is worn, off-white needs a button, and pink will not make me confident. Redo the interview options.',
    {'requested_count': 5, 'unavailable': ['shirt-blue', 'shirt-offwhite'], 'brief_exclusions': ['shirt-pink'], 'occasion': 'Interview', 'peak_c': 13},
    ['Respect the three distinct reasons for exclusion.', 'Keep pink in the wider taste profile; this is a scoped brief.', 'Do not demand an explanation of confidence.'])
historical('Shirt swap keeps the rest fixed', '78b65be8', 14,
    'Keep the blue work coat, olive chinos, navy sneakers, and dark blue socks. Which shirt can I change into?',
    {'locked': ['jacket-blue-work', 'trouser-olive', 'shoe-navy', 'sock-navy'], 'peak_c': 22, 'departure_c': 18},
    ['Offer only the requested shirt changes.', 'Use lightweight appropriate shirts and assess the complete combination.', 'Do not automatically fall back to navy.'])
historical('Warm-day swap avoids repairs and laundry', '78b65be8', 16,
    'Other lightweight oxfords, please. Camel and wine are too warm; gold is in the wash and off-white needs a button.',
    {'locked': ['jacket-blue-work', 'trouser-olive', 'shoe-navy', 'sock-navy'], 'unavailable': ['shirt-gold', 'shirt-offwhite'], 'too_warm': ['shirt-heavy-burgundy', 'shirt-camel'], 'peak_c': 22},
    ['Use the supplied exclusions immediately.', 'Select from the remaining lightweight range without inventory interrogation.'])
historical('Replace the selected calendar contents', '78b65be8', 10,
    'Use the navy option and replace tomorrow\'s outfit entry with just this one.',
    {'task': 'calendar_command', 'existing_event_id': 'fixture-day-event', 'selected_option_id': 'option-navy', 'existing_revision': 4},
    ['Replace the managed contents of the existing event.', 'Keep only the selected option, with the same event identity.', 'A write requires a receipt and read-back before claiming projection complete.'])
historical('Separate teal from forest green', '8f09c4d7', 14,
    'I have two forest green pairs as well as this teal pair. Correct the sock choices in future outfits.',
    {'task': 'observation_and_repair', 'owner_observation': 'Forest green quantity 2; teal quantity 1.', 'affected_outfit': 'Gold oxford with an incorrectly identified teal sock.'},
    ['Keep two distinct colors and the actual quantities.', 'Revisit affected color pairings without globally renaming all green socks.', 'No invented abundance or unidentified replacement product.'], extra=[('8f09c4d7', 16)])
historical('Named color follows the owner', '809a2145', 29,
    'Explain what to wear with my laurel shirt in terms I can recognize.',
    {'task': 'style_advice', 'source_code': 'PCF code exists in the item details; laurel is the visible alias.'},
    ['Use perceptible names in dressing advice.', 'Keep technical codes out of garment lines without losing their stored provenance.'],
    quote='You can omit PCF codes btw. I wouldn’t recognize them if you mentioned them. “Laurel shirt” I get. PCF I wouldn’t')
historical('Construction can spoil a beautiful fabric', '809a2145', 19,
    'The linen fabric is wonderful, but the fused cuffs bother me. How should that affect buying another?',
    {'task': 'purchase_advice', 'candidate_facts': 'A second shirt has the same fused cuff construction.'},
    ['Treat construction and tactile irritation as decisive evidence.', 'Do not let attractive cloth or a trusted maker erase the stated problem.'],
    quote='I have the canclini sun wash still, navy color. I don’t love it the most bc of the fused cufs and some construction. But the material is wonderful. It’s in the laundry, why I forgot it')
historical('Same label does not mean same fit', '809a2145', 37,
    'These two navy Games blazers have the same size label, but the cotton-linen one fits my waist better.',
    {'task': 'fit_observation', 'candidate_facts': 'Waist measurements are unpublished; chest labels match.'},
    ['Accept the worn fit observation and distinguish the cuts.', 'Do not use equal label or chest measurement to contradict the owner.', 'Do not invent unpublished waist dimensions.'])
historical('Probability and weekly reset', '809a2145', 144,
    'Plan a week of four choices per day without overusing garments that are likely to be in the wash.',
    {'task': 'rotation', 'requested_count_per_day': 4, 'weekly_reset': 'Sunday', 'selection_prior': 'Equal option prior before observed preferences.', 'no_confirmations': True},
    ['Estimate likely selection rather than reserving every option or assuming none is worn.', 'Respect quantities and shared-item correlations.', 'Apply the weekly reset without interrogating item status.'])
historical('Pink is not the default workhorse', '809a2145', 150,
    'Revise the rotation so it is varied and the Calendar descriptions are useful to scan.',
    {'task': 'rotation', 'existing_pattern': 'Pink is overrepresented; colored stripes and Californian plaid are rare.', 'calendar_format': 'Plain text, spaced garment lines, short explanation per option.'},
    ['Reduce pink dominance while retaining it as an option.', 'Increase the requested stripe and plaid range.', 'Use short substantive explanations, not dense strings or administrative headings.'])
historical('Do not sacrifice moss when reducing pink', '809a2145', 155,
    'Adjust that rotation: I love moss; reducing pink did not mean reducing the other well-fitting shirts.',
    {'task': 'rotation', 'priority_shirts': ['shirt-moss', 'shirt-slate', 'shirt-yellow-stripe', 'shirt-red-stripe', 'shirt-gold', 'shirt-laurel', 'shirt-plaid']},
    ['Keep the correction scoped to pink.', 'Respect fit and the affection for moss, slate, gold, laurel, and stripes.', 'Do not infer a ban on saturated colors.'])
historical('Plaid and stripes over generic office blue', '809a2145', 157,
    'There is only room for one more shirt in the rotation. Which earns the slot?',
    {'task': 'comparison', 'candidates': ['Californian rose/slate plaid, best fit', 'Light-blue solid oxford, already represented by similar blues']},
    ['Use the specific fit and variety evidence.', 'Do not default to light blue because it is the safest conventional office choice.'])
historical('Bias toward convenient hallway garments', '58385145', 54,
    'Plan a practical week using the jackets I can reach easily.',
    {'task': 'rotation', 'hallway': ['jacket-jungle', 'jacket-camel', 'jacket-academic', 'jacket-bark'], 'closet': ['coat-grey'], 'peak_c': 12},
    ['Use the reachable garments more often without pretending closet items are not owned.', 'Do not optimize visual novelty at the cost of daily physical effort.'])
historical('Jackets do not inherit a laundry cycle', '58385145', 60,
    'Why did you rule out the jungle jacket? I wore it yesterday, but it does not go in the laundry.',
    {'task': 'observation_and_repair', 'observed_wear': ['jacket-jungle'], 'care_policy': {'jacket-jungle': 'reusable'}},
    ['Restore ordinary eligibility and repair future suggestions.', 'Do not reset a real wear count or apply the trouser care rule to outerwear.'])
historical('A dislike replaces the candidate color', '58385145', 63,
    'I got weathered brown instead of olive; I did not like olive in practice. Update the combinations.',
    {'task': 'observation_and_repair', 'alias_scope': 'Allbirds colorway only', 'owned_other_olive': ['jacket-jungle', 'trouser-olive', 'shoe-olive']},
    ['Replace that specific shoe variant and repair its combinations.', 'Do not infer that the owner dislikes all olive garments or olive New Balance.'])
historical('The waist matters to fit', '45bff53d', 89,
    'The chest has room, but I am worried about the waist. What can we actually conclude?',
    {'task': 'fit_advice', 'body_waist_inches': 44, 'garment_half_chest_inches': 25.9, 'garment_waist_inches': None},
    ['Address waist, ease, cut, and missing dimensions.', 'Do not derive waist clearance from chest arithmetic or soothe with unsupported certainty.'])
historical('A camera cannot overrule the owner', '45bff53d', 93,
    'They are walnut trousers; the camera is shifting the color.',
    {'task': 'observation', 'model_previous_label': 'Grey', 'image_available': False},
    ['Accept the color correction and update affected descriptions.', 'Do not debate the observation or pretend to inspect missing image bytes.'])
historical('Comfortable feet outrank a dressier finish', '855a2469', 22,
    'I am walking today, so sneakers, not the leather shoes. Finish the outfit.',
    {'task': 'outfit_completion', 'locked': ['shirt-moss', 'trouser-beige'], 'walking': True, 'active_restriction': 'Sneakers only, including exclusion of 990v6.'},
    ['Choose an eligible comfortable sneaker and include socks.', 'Do not offer a short trial in welted shoes as a compromise.', 'Do not convert old break-in advice into current permission.'])

assert len(cases) == 40

current_policies = [
    ('No status interrogation', 'Do not ask me to confirm wear or item status. Estimate likely use and use the weekly laundry reset.', 'Do not ask the owner to resolve a missing-wear backlog.'),
    ('Daily wear count', 'One garment wear per wearing date; changing only the shirt increments only the new shirt.', 'Do not double-count unchanged garments.'),
    ('Duplicate merge', 'Merge independent wear reports by canonical garment and wearing date.', 'Preserve source provenance without counting duplicates.'),
    ('Owner observations win', 'Owner physical observations are authoritative; repair accounting internally.', 'A stale database version is not a dispute with the owner.'),
    ('Future repair', 'After actual wear makes a garment unavailable, automatically replace affected future suggestions.', 'Preserve the actual wear and unaffected parts of the brief.'),
    ('Calendar replacement', 'New contents replace the existing managed event; newer revisions supersede older deliveries.', 'No duplicate events or obsolete appended choices.'),
    ('Calendar influence', 'Calendar context influences a subset of options: three of five suitable for an event is a useful default.', 'Do not force every option into an inferred occasion.'),
    ('Independent taste judge', 'Codex judges output against the complete taste profile and historical preferences; taste is nondeterministic.', 'Do not require exact answer text or let candidates grade themselves.'),
]
for i, (title, instruction, meaning) in enumerate(current_policies, 1):
    evidence[f'owner-decision:{i}'] = {'id': f'owner-decision:{i}', 'kind': 'current_owner_decision', 'date': '2026-09-15', 'title': title, 'paraphrase': instruction, 'interpretation': meaning, 'source': 'Owner numbered response in this Codex task; paraphrase, not a verbatim export quotation.'}
evidence['owner-decision:features'] = {'id': 'owner-decision:features', 'kind': 'current_owner_decision', 'date': '2026-09-15', 'quote': 'and incorperate the "Features worth adding or making concrete" bits too pls', 'source': 'Owner follow-up in this Codex task.'}

def behavior(title, policy, prompt, state, criteria, family='accounting'):
    cases.append({'id': f'B{sum(c["id"].startswith("B") for c in cases)+1:03}', 'title': title, 'family': family, 'origin': 'constructed_from_owner_decision', 'source_ids': [f'owner-decision:{policy}'], 'prompt': prompt, 'scenario': state, 'judge_criteria': criteria, 'construction_note': 'Constructed scenario; this sequence is not claimed to have occurred in the export.'})

behavior('A week without confirmations', 1, 'Show tomorrow\'s five outfits.', {'task': 'board', 'requested_count': 5, 'unresolved_selections': 6, 'confirmed_wears': 0, 'day': 'Thursday'}, ['Produce useful options using estimated availability.', 'Ask zero status questions; create no confirmation tasks.', 'Do not manufacture six confirmed wears.'])
behavior('Weekly reset with an exception', 1, 'Show the Sunday board.', {'task': 'board', 'cycle': 'Friday service, Saturday return, Sunday reset', 'exception': 'Owner says the moss shirt is still at the tailor.', 'handwash_socks': 'Separate cycle'}, ['Reset routine service cleanliness estimates once.', 'Keep the tailor restriction and hand-wash state.', 'Do not claim an observed laundry return.'])
behavior('Shared trousers on a five-option board', 1, 'Plan tomorrow with these two pairs of navy chinos.', {'task': 'probability', 'options': 5, 'navy_occurs_in_options': 3, 'navy_quantity': 2, 'option_prior': 0.2, 'board_choice_probability': 1.0, 'prior_note': 'This controlled fixture conditions on choosing one of these five options; ordinary runs can assign probability to a different outfit.'}, ['The one-day probability of selecting navy is 0.6 under this fixture, not three wears.', 'No observation means no confirmed wear count.', 'Treat alternatives and quantities coherently.'])
behavior('Change only the shirt', 2, 'I changed from moss to the red stripe, kept everything else.', {'task': 'observation', 'date': '2026-09-15', 'already_worn': ['shirt-moss', 'trouser-olive', 'sock-navy', 'shoe-navy'], 'new': ['shirt-red-stripe']}, ['Increment only red stripe by one.', 'Preserve the real moss wear and all existing counts.', 'No second trouser or sock consumption.'])
behavior('Same garment on a later date', 2, 'I wore these trousers yesterday and today.', {'task': 'observation', 'dates': ['2026-09-14', '2026-09-15'], 'garment': 'trouser-olive'}, ['Record two daily wears.', 'Do not reject actual wear because the planner would avoid a repeat.', 'Do not merge separate wearing dates.'])
behavior('Phone and MCP report the same wear', 3, 'Sync these wear reports.', {'task': 'observation', 'reports': [{'client': 'phone', 'submission': 'a', 'date': '2026-09-15', 'garment': 'shirt-moss'}, {'client': 'MCP', 'submission': 'b', 'date': '2026-09-15', 'garment': 'shirt-moss'}]}, ['One counted wear and two retained evidence references.', 'No question about whether two occasions occurred.'])
behavior('A late report before a known wash', 4, 'I forgot to log it, but I wore the moss shirt yesterday.', {'task': 'observation', 'report_date': '2026-09-15', 'known_events': ['Moss shirt washed at 10 AM on September 15.']}, ['Record yesterday\'s wear.', 'Keep today\'s clean state; arrival order does not reverse event order.', 'No accounting conflict question.'])
behavior('Unexpected wash', 4, 'I just washed those trousers.', {'task': 'observation', 'garment': 'trouser-olive', 'ledger': 'Estimated dirty; no wash job scheduled.'}, ['Record the wash and make the trousers clean.', 'No requirement for an expected laundry batch.', 'Preserve actual prior wear counts.'])
behavior('Worn despite an unavailable ledger state', 4, 'I have the blue work coat on right now.', {'task': 'observation', 'garment': 'jacket-blue-work', 'ledger': 'At tailor'}, ['Accept current possession and wear and repair the incompatible location.', 'No proof request, refusal, or invention of a second coat.'])
behavior('Merge aliases after independent reports', 3, 'Blue work coat and cotton-linen chore mean the same coat.', {'task': 'identity_merge', 'reports': [{'garment': 'old-work', 'date': '2026-09-15'}, {'garment': 'old-chore', 'date': '2026-09-15'}]}, ['Merge identity and retain aliases.', 'Collapse the duplicate daily wear without erasing provenance.'])
behavior('Repair a selected future outfit', 5, 'I wore the gold shirt today.', {'task': 'observation_and_repair', 'future_selected': {'tomorrow': ['shirt-gold', 'trouser-beige', 'shoe-olive', 'sock-navy', 'belt-brown']}, 'care': 'Shirt unavailable for a fresh wear until wash'}, ['Record today\'s wear and replace tomorrow\'s shirt automatically.', 'Keep unaffected future pieces and actual history.', 'Do not request approval of ordinary repair.'])
behavior('Out-of-order calendar effects', 6, 'Synchronize the outfit event.', {'task': 'calendar_projection', 'event_id': 'same-event', 'remote_revision': 12, 'queued_effects': [11, 12]}, ['Skip revision 11; retain revision 12.', 'Keep one event and one current board, with no appended older choices.'])
behavior('Calendar shapes three of five choices', 7, 'Give me five options for today.', {'task': 'board', 'requested_count': 5, 'calendar': [{'title': 'Gallery dinner', 'status': 'accepted'}, {'title': 'Formal reception', 'status': 'declined'}]}, ['Provide a useful event-suitable majority and other options.', 'Do not treat the declined event as a dress code.', 'Keep the personality and comfortable footwear across the set.'])
behavior('Quiet interest is still personal', 8, 'A quiet day at home and a short walk. One outfit, please.', {'task': 'board', 'requested_count': 1, 'day_brief': 'Quiet, low effort; no statement piece requested.', 'peak_c': 12}, ['A white tee, jeans, textured cardigan, socks, and suitable shoes can pass.', 'Do not require drama, a saturated accent, or a blazer to satisfy taste.', 'Judge the whole combination, not keyword inclusion.'], 'taste')
behavior('Packing uses the actual suitcase', 'features', 'Three days away, one dinner, carry-on only. Suggest outfits from what I packed.', {'task': 'packing', 'packed': ['shirt-moss', 'shirt-red-stripe', 'trouser-beige', 'jacket-academic', 'shoe-navy', 'sock-navy', 'belt-brown'], 'home_only': ['shirt-gold'], 'laundry_at_destination': 'None', 'trip_repeat_exception': True}, ['Use only packed stock and explicit quantities.', 'Reuse deliberately under the trip exception.', 'Do not wash suitcase contents with the home weekly reset.'], 'feature')
behavior('Return deadline with the right trigger', 'features', 'Remind me to return this shirt in time.', {'task': 'return', 'fixture_terms': 'Request within 14 calendar days after receipt; post within seven days after authorization.', 'received_on': '2026-09-01', 'authorization': None}, ['Derive the request deadline as September 15 under these supplied terms.', 'Do not invent a posting deadline before authorization.', 'No removal from owned stock merely for preparing the return.'], 'feature')
behavior('Optional comfort feedback', 'features', 'The heavy shirt was too warm on the train.', {'task': 'comfort', 'garment': 'shirt-heavy-burgundy', 'occasion': 'Warm train carriage; outside temperature not supplied.'}, ['Record scoped indoor discomfort and inform similar advice.', 'No questionnaire and no universal ban on the garment.', 'Do not invent weather or medical conclusions.'], 'feature')
behavior('Resume without a backlog', 'features', 'Resume my outfits after two weeks away.', {'task': 'resume', 'missed_days': 14, 'return_deadline': 'Tomorrow', 'weekly_reset': 'Sunday'}, ['Prepare the next useful board with fresh context and applicable resets.', 'No missed-wear interrogation or old notifications.', 'Retain the independently active return deadline.'], 'feature')
behavior('Recover the same owner', 'features', 'I lost access to my Google account. Recover my wardrobe using my recovery kit.', {'task': 'identity_recovery', 'recovery_credential': 'Valid test fixture verified outside the model', 'old_user_id': 'owner-fixture'}, ['Use the supported recovery flow to retain the same internal owner.', 'Never treat personal trivia as proof or expose recovery tokens in chat.', 'Revoke old sessions and rotate the recovery credential.'], 'feature')
behavior('Export a complete portable record', 'features', 'Export everything I need to take my wardrobe elsewhere.', {'task': 'export', 'available_sources': ['D1', 'Session originals', 'profile and amendments', 'R2 media', 'research'], 'credentials_present_in_backend': True}, ['Produce a versioned manifest, original records and media, readable views, and checksums.', 'Omit credentials and recovery verifiers.', 'Report incomplete components honestly and never replay external effects on import.'], 'feature')
behavior('Drama through proportion and texture', 8, 'Give me three dramatic outfits for lunch and a long stroll, centered on the grey grandad coat.', {'task': 'board', 'requested_count': 3, 'locked': ['coat-grey'], 'peak_c': 12, 'departure_c': 9, 'walking': True}, ['Create drama through silhouette, value, texture, or register rather than several loud colors.', 'Use the coat as specified and comfortable eligible sneakers.', 'Do not add a hot indoor knit merely to make the outfit more elaborate.'], 'taste')
behavior('A loud rugby needs quieter support', 8, 'I want to wear the red rugby with the burnt-orange trousers. Complete the outfit.', {'task': 'board', 'requested_count': 1, 'locked': ['shirt-red-rugby', 'trouser-orange'], 'peak_c': 12, 'departure_c': 9}, ['Assess the two strong colors honestly and use restrained supports such as a blue or off-white relationship.', 'Do not add a third competing statement color or praise every combination uncritically.', 'A clear reasoned reservation can accompany a complete best-available outfit.'], 'taste')
behavior('Old enthusiasm does not override the profile', 8, 'Which of these would add most to my wardrobe?', {'task': 'purchase_advice', 'candidates': ['A field watch', 'A cable V-neck merino sweater', 'A textured Shetland cardigan'], 'historical_note': 'An older assistant praised watches and cable knits; that is not a current owner instruction.', 'stock_not_verified': True}, ['Apply the complete September profile: no watch requirement, no cable V-neck, no merino sweater default.', 'A Shetland cardigan or no purchase is defensible depending on wardrobe overlap.', 'Do not turn the owner\'s formation into cosplay or status signaling.'], 'taste')
behavior('Provenance without an invented story', 8, 'Tell me how this French chore coat connects to the French Revolution and student protest.', {'task': 'historical_research', 'provided_sources': [{'id': 'fixture-maker', 'text': 'This contemporary maker describes the design as inspired by work jackets.'}], 'external_research_performed': False}, ['Distinguish an appealing premise from a supported historical connection.', 'Do not invent dates, revolutionary provenance, or student adoption from the style profile.', 'A useful account states what is supported and what research is still needed without pretending a search occurred.'], 'research')
assert len(cases) == 64

# A fixture bank, deliberately not a reconstruction of today's wardrobe.
items = []
def item(id, name, role, **kwargs):
    items.append({'id': id, 'name': name, 'role': role, 'owned': True, 'quantity': 1, 'availability': 'observed_available', **kwargs})
for color in ['moss', 'slate', 'pink', 'gold', 'laurel', 'blue', 'offwhite', 'yellow-stripe', 'red-stripe']:
    item('shirt-'+color, color.replace('-', ' ')+' lightweight oxford', 'shirt', fabric='Cotton lightweight oxford', collar='Sewn button-down', care='Single wear-day')
item('shirt-plaid', 'Rose and slate Californian plaid shirt', 'shirt', fabric='Lightweight cotton')
item('shirt-heavy-burgundy', 'Burgundy heavy oxford', 'shirt', fabric='Heavy cotton oxford')
item('shirt-camel', 'Camel cotton twill shirt', 'shirt', fabric='Heavy cotton twill')
item('shirt-tee', 'White cotton crew-neck tee', 'shirt', fabric='Dry cotton jersey')
item('shirt-red-rugby', 'Red cotton rugby shirt', 'shirt', fabric='Midweight cotton jersey')
for color in ['navy', 'walnut', 'beige', 'olive', 'grey']:
    item('trouser-'+color, color+' chinos', 'trousers', fabric='All-season cotton', quantity=2 if color in ['navy','walnut'] else 1, care='Single wear-day')
item('trouser-jeans', 'Mid-wash jeans', 'trousers', fabric='Cotton denim')
item('trouser-orange', 'Burnt-orange cotton trousers', 'trousers', fabric='All-season cotton')
item('trouser-charcoal', 'Charcoal wool trousers', 'trousers', fabric='All-season wool')
item('trouser-brown-cord', 'Brown corduroy trousers', 'trousers', fabric='Medium-weight cotton cord')
item('trouser-heavy-beige', 'Beige heavy corduroy trousers', 'trousers', fabric='Heavy winter-weight cotton cord')
for id,name,fabric in [
    ('jacket-jungle','Olive jungle jacket','Soft cotton herringbone'),
    ('jacket-hunter','Muted olive hunter jacket','Light waxed cotton; waterproofing unverified'),
    ('jacket-academic','Salt-and-pepper academic blazer','Soft unstructured tweed'),
    ('jacket-camel','Camel Games blazer','Cotton twill'),
    ('jacket-bark','Bark blazer','Textured cotton and cashmere'),
    ('jacket-blue-work','Blue work coat','Cotton and linen outerwear'),
    ('jacket-black','Black chore coat','Heavy cotton twill'),
    ('jacket-tweed','Dark flecked tweed blazer','Heavy wool tweed'),
    ('coat-grey','Grey grandad coat','Mid-light grey wool herringbone'),
    ('cardigan-grey','Grey textured cardigan','Shetland wool')]:
    item(id,name,'outerwear',fabric=fabric,care='Reusable')
for color in ['navy','grey','olive']:
    item('shoe-'+color, color+' New Balance 990v4', 'shoes', footwear_kind='sneaker', size='UK 8.5', care='Never laundered')
item('shoe-990v6', 'Navy New Balance 990v6', 'shoes', footwear_kind='sneaker', availability='restricted')
item('shoe-welted', 'Café Paraboot Reims', 'shoes', footwear_kind='welted', availability='restricted')
for color in ['navy','brown','forest','teal','mustard','grey','burgundy']:
    item('sock-'+color, color+' merino socks', 'socks', fabric='Wicking merino', quantity=2 if color!='teal' else 1, care='Hand-wash')
for color in ['brown','olive','black']:
    item('belt-'+color, color+' woven belt', 'belt', care='Never laundered')
for color in ['rust','burgundy','navy','green']:
    item('tie-'+color, color+' square-ended silk knit tie', 'tie', care='Reusable')
for color in ['green','burgundy','blue']:
    item('scarf-'+color, ('Muted olive' if color=='green' else color)+' wool-silk scarf', 'scarf', care='Reusable')
save('fixtures/wardrobe.json', {'kind': 'constructed_evaluation_fixture', 'not_live_inventory': True, 'default_date': '2026-09-15', 'timezone': 'Europe/London', 'default_peak_c': 18, 'default_departure_c': 12, 'items': items, 'policy': 'Read the full profile and current amendments; case facts override fixture defaults.'})

# Hold out entire conversations, never adjacent turns from the same conversation.
held_prefixes = ['855a2469', 'f9ddd6fa', '809a2145']
for c in cases:
    held = any(any(prefix in sid for prefix in held_prefixes) for sid in c['source_ids'])
    c['split'] = 'holdout' if held else 'development'
    if c['id'].startswith('B') and int(c['id'][1:]) % 4 == 0:
        c['split'] = 'holdout'
    c['profile_path'] = 'sources/chris-wardrobe-profile.md'
    c['profile_sha256'] = hashlib.sha256(PROFILE.read_bytes()).hexdigest()
    c['amendments_path'] = 'sources/owner-amendments.md'
    c['fixture_path'] = 'fixtures/wardrobe.json'
    c['historical_images_available'] = False
save('cases.json', cases)
save('sources/evidence.json', evidence)
terms = ['wardrobe','outfit','garderobe','drake','paraboot','oxford','chore','rugby','shetland','proper cloth','ivy','consign','trouser']
candidate_count = 0
for c in conversations:
    body = ' '.join(message_text(m) for m in c['chat_messages'] if m['sender']=='human').lower()
    score = sum(body.count(t) for t in terms)
    if score >= 8 or any(t in c['name'].lower() for t in terms): candidate_count += 1
save('sources/manifest.json', {
    'export_path': str(EXPORT), 'export_sha256': hashlib.sha256(raw).hexdigest(),
    'conversation_count': len(conversations), 'keyword_candidate_count': candidate_count,
    'selection_method': 'Title match or at least eight occurrences of wardrobe terms in owner messages; manually selected evidence from relevant conversations, not an exhaustive preference annotation.',
    'export_created_min': min(c['created_at'] for c in conversations),
    'export_updated_max': max(c['updated_at'] for c in conversations),
    'selected_conversation_count': len({e['conversation_id'] for e in evidence.values() if e['kind']=='owner_history'}),
    'historical_evidence_count': sum(e['kind']=='owner_history' for e in evidence.values()),
    'profile_source': str(PROFILE), 'profile_sha256': hashlib.sha256(PROFILE.read_bytes()).hexdigest(),
    'profile_copied_verbatim': True, 'history_images_included': False,
    'case_count': len(cases), 'history_case_count': 40, 'owner_policy_and_feature_case_count': 24,
    'split_counts': {s: sum(c['split']==s for c in cases) for s in ['development','holdout']},
    'privacy': 'Local private evaluation corpus. No export uploaded and no source tool instructions executed.'
})
print(json.dumps(json.loads((ROOT/'sources/manifest.json').read_text()), indent=2))
