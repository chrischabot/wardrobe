"""Serialize the eight judgments made by Codex in the authoring task."""
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sources=json.loads((ROOT/'sources/calibration-candidates.json').read_text())
dimensions=['personal_fit','composition','comfort_and_fabric','variety_and_scope','practical_usefulness','voice_and_teaching']
records=[]

def judgment(index,verdict,scores,summary,findings,violations=(),limitations=()):
    source=sources[index-1]
    for excerpt,basis,note in findings:
        assert excerpt in source['candidate'],(index,excerpt)
    records.append({
        'case_id':source['id'],'related_case_id':source['related_case_id'],
        'candidate_id':f'anonymous-{index}', 'mode':'historical_response_review',
        'candidate_sha256':source['candidate_sha256'],
        'verdict':verdict,'scores':dict(zip(dimensions,scores)),
        'hard_violations':list(violations),
        'findings':[{'candidate_excerpt':a,'basis':b,'judgment':c} for a,b,c in findings],
        'limitations':source['limitations']+list(limitations), 'summary':summary,
    })

judgment(1,'revise',[4,4,None,None,3,2],
    'Understands the relaxed academic register, but gives too much flattering performance and overstates the contrast with tweed.',[
    ('it signals intentionality without formality.','Profile sections 2, 3, and 6; historical owner message 019d54d7-43a0-700b-9f1c-888ea3797ba1.','This identifies the desired register well: a considered blazer without business formality.'),
    ('The clothes are good because the person wearing them has good instincts','Profile section 11.','Flattery replaces a useful explanation of the clothes.'),
    ('a Mk. VII Harris Tweed would have been too composed, too "dressed."','Profile section 3 admits textured academic blazers; construction and actual outfit evidence matter.','This may describe a specific jacket, but the supplied packet does not establish its construction or why it necessarily fails. Avoid a categorical tweed-versus-cotton rule.')],
    limitations=['The no-canvas construction assertion and the visual scarf comparison are not verified from this packet.'])
judgment(2,'revise',[4,None,4,3,3,2],
    'Recognizes the tactile preference and the risk of ordering many untested sizes, but endorses the purchase too readily and adds unnecessary psychological framing.',[
    ('that slightly nubby, almost grainy quality','Profile section 4; historical owner message 019c7263-0d4a-7d0b-9dff-96c19d07229f.','The physical explanation connects to the owner\'s stated enjoyment of the weave.'),
    ("That's not impulse buying, that's how a considered wardrobe works.",'Profile sections 10 and 11 require judgment rather than reassurance or flattery.','The reply cannot establish this conclusion from enjoying a fabric. It prematurely validates the buying decision.'),
    ('With the new measurements being untested, that\'s a lot riding on one fit profile.','The owner describes an experimental measurement order in the same conversation.','This is a useful concrete counterargument and improves the advice.')],
    limitations=['Exact thread count and the full cart are not independently verified in the selected context. No medical claim is adopted by this review.'])
judgment(3,'fail',[2,None,None,2,2,2],
    'Finds the repetition problem but replaces it with rigid quotas and more decisions for the owner.',[
    ('no trouser colour or footwear may repeat across the set','Owner decision 1; profile section 6; historical owner message 019dbe5f-956b-7fef-9f48-a12bc3a55270.','This overconstrains variety instead of considering availability, quantity, and composition. Brown is still liked.'),
    ('Two questions before I commit it:','Profile section 11 and the September 15 decision-light operating policy.','The response leaves the owner to design exceptions rather than presenting a usable proportional rule.'),
    ('all three Allbirds (Navy/Grey/Brown) must appear','Historical request asks for a better spread, not a permanent requirement that each brand/color occur in every set.','A fixed brand quota is not a general taste rule and does not adapt to changing eligible stock.')])
judgment(4,'fail',[2,2,2,4,2,2],
    'Preserves the requested swap scope but offers poorly grounded thermal alternatives and a blanket ban on green-on-green combinations.',[
    ('only the shirt is in question.','Historical request 019e7d3b-ec01-7744-824d-4b9415c45628; profile section 11.','This correctly keeps the existing outfit intact.'),
    ('the heavier weave is arguably the best wind answer.','Profile section 8 distinguishes peak-temperature base garments from the outer layer that covers wind and a cool start.','The coat is already retained for wind; using that as the reason for a heavier base at a 22 C peak poorly serves the brief.'),
    ('every one of them stacks green on the olive trouser and turns the fit muddy.','Profile sections 5 and 6 permit tonal depth, greyed adjacency, and coherent quiet combinations.','This categorical prohibition substitutes a simplistic rule for assessment of actual hues, values, and texture.'),
    ('gold lightweight oxford (PCF4627)','Profile sections 8 and 11; perceptible names are the dressing interface.','The readable garment name is useful, but the extra product code adds no value at the wardrobe.')],
    limitations=['Gold laundry and off-white repair were disclosed in the following owner message. They are not charged as already-known violations in this historical review.', 'The omitted tool output prevents independent verification of the claimed inventory read.'])
judgment(5,'fail',[2,None,1,None,1,3],
    'Acknowledges the waist concern but then supplies invented precision from a chest measurement, which defeats the purpose of the correction.',[
    ('circumference at waist sits close to chest — 51.8" full','Profile section 7; historical owner message 019e3f64-451c-7247-ae42-ca76bde2a6e7.','Chest circumference and cut assumptions do not establish the missing waist dimension.'),
    ('it won\'t compress or cling','The candidate itself states that the relevant chart information is missing.','This definitive fit promise is not supported by the measurement evidence.'),
    ('a sz44 garment with ~7-8" of designed waist ease','Profile section 11: verify before asserting.','Calling inferred ease designed ease turns an estimate into a construction fact.')],
    violations=['Unsupported garment waist measurement and definitive fit assurance from chest-only evidence.'],
    limitations=['The historical screenshot and retailer return terms are not available; this review does not verify the claimed 28-day return window.'])
judgment(6,'revise',[None,None,None,4,2,3],
    'Corrects the jacket rule but stops to ask permission to continue an already requested rotation.',[
    ('no weekly limit.',f"Historical owner message {sources[5]['request_message_id']}; profile sections 9 and 11.",'Correctly removes the invented weekly laundry restriction from jackets.'),
    ('Ready to build the 28 days now. Shall I go?','Historical context is an ongoing requested rotation; owner amendment emphasizes low-effort execution.','The extra approval question leaves the actual work unfinished.')],
    limitations=['This is a conversational-response assessment, not verification that any wardrobe rule was saved.'])
judgment(7,'pass',[4,4,None,4,4,3],
    'Makes a defensible charcoal choice from the corrected coat value and explains the silhouette; the categorical language about other grey pairings needs restraint.',[
    ('Charcoal trousers it is.','Historical owner message 019ce89f-e6c1-7ca2-8743-c2b82e6349f7; profile sections 5 and 6.','A clear recommendation follows the owner\'s corrected tonal description.'),
    ('that value contrast is what creates the silhouette','Profile sections 5 and 6.','The explanation is about visible relationships and proportion rather than status or a generic style label.'),
    ('Two similar-value greys in two different patterns just reads as muddy rather than considered.','Profile section 5 also allows greyed adjacency and depth within one color.','Too absolute as a general rule, but it does not invalidate the specific charcoal recommendation.')],
    limitations=['This passes the textual choice and reasoning task only. Missing image bytes prevent a visual composition verdict.'])
judgment(8,'insufficient_evidence',[3,None,None,4,3,3],
    'Accepts the walnut correction, but the visible text alone cannot establish the confident photographic and saturation judgments.',[
    ('Confirmed walnut','Historical owner message 019e3fd2-93d0-7d72-a3bc-54c7b7d04480; owner observation precedence.','Accepting the owner\'s color description is correct.'),
    ('the close-up shows the warm tan-brown clearly, with the twill weave visible.','Historical photo bytes are absent from the supplied export packet.','This review cannot validate the visual claim. That absence is not proof that the original assistant lacked the photo.'),
    ('coherent through and through','Profile sections 5 and 6: saturation discipline and avoidance of several competing statement colors.','Pink, saturated yellow, walnut, and olive require actual shade and proportion evidence. The praise is more certain than this packet permits.')],
    limitations=['Do not grade this as a verified visual success or infer a false historical hallucination solely from unavailable photos.'])

result={
    'review_date':'2026-09-15','judge':'Codex in the current authoring task',
    'judge_model_id':'Not independently recorded by runtime metadata; no invented exact model ID.',
    'candidate_origin':'Eight real visible assistant replies in the provided Claude export; provider metadata not used as a scoring cue.',
    'profile_sha256':json.loads((ROOT/'sources/manifest.json').read_text())['profile_sha256'],
    'method':'One retrospective pass, full September profile and current amendments. Exact visible reply text only. No model comparison, no live application run, and no repeatability claim.',
    'judgments':records,
}
(ROOT/'results/initial-judge-review.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
lines=['# Initial Codex judge review','', 'Codex reviewed eight actual visible historical replies against the full September profile and current owner amendments. This is one retrospective pass over development examples, not a measured application result or repeated judge calibration. Missing images and tool evidence limit the findings.','', '| Reply | Related case | Verdict | Main finding |','| --- | --- | --- | --- |']
for r in records:lines.append(f"| {r['case_id']} | {r['related_case_id']} | {r['verdict'].replace('_',' ')} | {r['summary']} |")
lines+=['','The review distinguishes several material patterns: recognizing the academic register does not excuse flattery; variety does not require rigid shoe quotas; a scoped swap must preserve the rest of the outfit; and missing waist measurements cannot be replaced with chest arithmetic. The charcoal-trouser comparison is a defensible recommendation even though another well-supported combination could also pass.','', 'One image-dependent reply remains insufficiently evidenced. The judge does not fabricate the image, declare the old assistant wrong merely because its attachment is missing, or treat its confident prose as verification.','', 'All exact excerpts, evidence bases, scores, and limitations are retained in `initial-judge-review.json`. Candidate originals and message IDs are in `../sources/calibration-candidates.json`.']
(ROOT/'results/initial-judge-review.md').write_text('\n'.join(lines)+'\n')

cases=json.loads((ROOT/'cases.json').read_text())
catalogue=['# Evaluation cases','', 'These are constructed tasks grounded in the cited owner evidence. The complete profile and September amendments accompany every candidate. Historical feedback and judgment criteria are judge-only material.','']
for c in cases:
    catalogue += [f"## {c['id']}: {c['title']}",'',f"Split: {c['split']}. Family: {c['family']}. Origin: {c['origin']}.",'',c['prompt'],'','Scenario:','', '```json',json.dumps(c['scenario'],ensure_ascii=False,indent=2),'```','', 'The judge checks the following:', '']
    catalogue += ['- '+criterion for criterion in c['judge_criteria']]
    catalogue += ['', 'Evidence: '+', '.join('`'+s+'`' for s in c['source_ids'])+'.','']
(ROOT/'cases.md').write_text('\n'.join(catalogue)+'\n')
print(f'Wrote eight Codex judgments and a readable {len(cases)}-case catalogue.')
