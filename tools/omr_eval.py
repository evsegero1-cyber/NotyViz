import sys, json, time
sys.path.insert(0,'/home/claude/tools')
from gt import load
from playwright.sync_api import sync_playwright
D='/tmp/real/at/packages/alphatab/test-data/musicxml-samples/'
names=sys.argv[1:] or ['MozaChloSample','DebuMandSample','BeetAnGeSample','SchbAvMaSample','Dichterliebe01','Echigo','BrahWiMeSample','FaurReveSample','MahlFaGe4Sample','MozaVeilSample','BrookeWestSample']
tot=[0,0,0,0]
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
    for nm in names:
        pg=b.new_page(); logs=[]; pg.on('console',lambda m: logs.append(m.text)); pg.on('pageerror',lambda e: logs.append('ERR '+str(e)))
        pg.goto(f'http://localhost:8765/_omr.html?f=_samples/{nm}.pdf')
        r=None
        for i in range(240):
            r=pg.evaluate('window.__res')
            if r: break
            time.sleep(0.25)
        pg.close()
        if not r or 'error' in r: print(nm,'ERROR',r and r.get('error'),logs[-3:]); continue
        gt=load(D+nm.split('_')[0]+'.xml')
        rep=r['report']
        line=f"{nm}: {r['ms']:.0f}ms systems {rep['systems']} staves {rep['staves']} measures {len(r['measures'])}/{gt[0]['measures']} tracks {[t['name']+':'+str(len(t['notes'])) for t in r['tracks']]} gt {[g['name']+':'+str(len(g['notes'])) for g in gt]} unsureM {len(rep['unsureMeasures'])}"
        print(line)
        # match parts by order
        for gi,g in enumerate(gt):
            if gi>=len(r['tracks']): break
            rec=r['tracks'][gi]['notes']
            G={}; 
            for (m,o,mi) in g['notes']: G.setdefault((m,round(o*24),mi),0); G[(m,round(o*24),mi)]+=1
            Rr={}
            for (m,o,mi,u,d) in rec: Rr.setdefault((m,round(o*24),mi),0); Rr[(m,round(o*24),mi)]+=1
            hit=sum(min(v,Rr.get(k,0)) for k,v in G.items())
            # pitch-only per measure
            from collections import Counter
            GP=Counter((m,mi) for (m,o,mi) in g['notes']); RP=Counter((m,mi) for (m,o,mi,u,d) in rec)
            ph=sum(min(v,RP.get(k,0)) for k,v in GP.items())
            ng=len(g['notes']); nr=len(rec)
            tot[0]+=hit; tot[1]+=ng; tot[2]+=nr; tot[3]+=ph
            print(f"   {g['name'][:14]:14s} gt {ng:4d} rec {nr:4d}  pitch+onset recall {hit/max(1,ng):.2f} prec {hit/max(1,nr):.2f} | pitch-in-measure recall {ph/max(1,ng):.2f}")
        for l in logs[-3:]: print('   log',l)
    b.close()
print('TOTAL recall %.3f precision %.3f pitch-measure recall %.3f'%(tot[0]/max(1,tot[1]),tot[0]/max(1,tot[2]),tot[3]/max(1,tot[1])))
