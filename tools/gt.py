# Ground truth from MusicXML: list of parts, each list of (measureIndex, onsetInMeasure(quarters), midi)
import sys, zipfile, xml.etree.ElementTree as ET, json
STEP={'C':0,'D':2,'E':4,'F':5,'G':7,'A':9,'B':11}
def load(path):
    raw=open(path,'rb').read()
    import re
    if raw[:2] in (b'\xff\xfe', b'\xfe\xff'): txt=raw.decode('utf-16')
    else: txt=raw.decode('utf-8','replace')
    txt=re.sub(r'<\?xml[^>]*\?>','',txt,1); txt=re.sub(r'<!DOCTYPE[^>]*>','',txt,1)
    root=ET.fromstring(txt)
    names={sp.get('id'):(sp.findtext('part-name') or '') for sp in root.iter('score-part')}
    parts=[]
    for part in root.findall('part'):
        notes=[]; div=1; mi=0
        for meas in part.findall('measure'):
            pos=0; last_on=0
            for el in meas:
                if el.tag=='attributes':
                    d=el.findtext('divisions');
                    if d: div=int(d)
                elif el.tag=='backup': pos-=int(el.findtext('duration'))
                elif el.tag=='forward': pos+=int(el.findtext('duration'))
                elif el.tag=='note':
                    if el.find('grace') is not None or el.find('cue') is not None: continue
                    dur=int(el.findtext('duration') or 0)
                    chord=el.find('chord') is not None
                    on=last_on if chord else pos
                    if not chord: last_on=pos
                    p=el.find('pitch')
                    tie_stop=any(t.get('type')=='stop' for t in el.findall('tie'))
                    if p is not None and not tie_stop:
                        midi=12*(int(p.findtext('octave'))+1)+STEP[p.findtext('step')]+int(float(p.findtext('alter') or 0))
                        notes.append((mi,round(on/div,4),midi))
                    if not chord: pos+=dur
            mi+=1
        parts.append({'name':names.get(part.get('id'),''),'notes':notes,'measures':mi})
    return parts
if __name__=='__main__':
    print(json.dumps(load(sys.argv[1]))[:500])
