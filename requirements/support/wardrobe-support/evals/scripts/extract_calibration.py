"""Retain eight visible historical replies for an initial Codex judge review."""
import sys
from pathlib import Path
import hashlib
import json
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evaluate import ROOT, visible

conversations=json.loads(Path('/Users/chabotc/Downloads/claude-history-export/conversations.json').read_text())
selections=[('00f38a2a',11,'H001'),('1413ceab',9,'H007'),('db2a79aa',1,'H016'),('78b65be8',15,'H024'),('45bff53d',90,'H038'),('58385145',61,'H036'),('f80d8ea7',11,'H012'),('45bff53d',94,'H039')]
records=[]
for number,(prefix,index,related_case) in enumerate(selections,1):
    c=next(c for c in conversations if c['uuid'].startswith(prefix))
    m=c['chat_messages'][index]
    assert m['sender']=='assistant'
    candidate=visible(m)
    assert candidate
    request=c['chat_messages'][index-1]
    assert request['sender']=='human'
    context=[]
    for j in range(max(0,index-6),index):
        msg=c['chat_messages'][j]
        body=visible(msg)
        if body:
            context.append({'message_id':msg['uuid'],'speaker':msg['sender'],'text':body})
    record={
        'id':f'C{number:03}', 'related_case_id':related_case,
        'mode':'historical_response_review',
        'conversation_id':c['uuid'],'conversation_title':c['name'],
        'assistant_message_index':index,'assistant_message_id':m['uuid'],
        'created_at':m['created_at'],'request_message_id':request['uuid'],
        'request':visible(request),'context':context,'candidate':candidate,
        'candidate_sha256':hashlib.sha256(candidate.encode()).hexdigest(),
        'extraction':'Only structured content parts with type=text; no thinking, tool-use, or tool-result parts.',
        'limitations':['Historical images are not included.', 'Full model input and tool receipts are not reconstructed.', 'Current-profile retrospective review; not a live application run or controlled historical benchmark.'],
    }
    records.append(record)
(ROOT/'sources/calibration-candidates.json').write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n')
print('Extracted',len(records),'visible replies; thinking and tool parts excluded.')
for r in records:
    print('\n'+r['id']+' '+r['related_case_id']+'\n'+r['candidate'])
