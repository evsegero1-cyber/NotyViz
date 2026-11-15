import os, sys, json, re, math, collections, numpy as np, soundfile as sf
sys.path.insert(0, os.path.dirname(__file__))
import sfz
from sf2 import SF2
EXT='/home/claude/ext'
OUT=sys.argv[1] if len(sys.argv)>1 else '/home/claude/notyviz/app/src/main/assets/snd'
only=set(sys.argv[2:])
Q=0.42  # vorbis compression level (0 best .. 1 smallest)
NOTE={'c':0,'d':2,'e':4,'f':5,'g':7,'a':9,'b':11}
def key(v):
    if v is None: return None
    v=str(v)
    if v.lstrip('-').isdigit(): return int(v)
    m=re.match(r'([a-gA-G])([#b]?)(-?\d)',v)
    n=NOTE[m.group(1).lower()]+(1 if m.group(2)=='#' else -1 if m.group(2)=='b' else 0)
    return n+12*(int(m.group(3))+1)
class Pack:
    def __init__(s,name,meta):
        s.name=name; s.dir=os.path.join(OUT,name); os.makedirs(s.dir,exist_ok=True)
        s.meta=meta; s.samples=[]; s.idx={}; s.programs={}; s.bytes=0
    def add(s,keyid,data,sr,trim=None,fade=0.3):
        if keyid in s.idx: return s.idx[keyid]
        if data.ndim>1 and data.shape[1]==1: data=data[:,0]
        if trim and len(data)>trim*sr:
            n=int(trim*sr); data=data[:n].copy(); f=int(fade*sr)
            env=np.linspace(1,0,f); 
            if data.ndim>1: env=env[:,None]
            data[-f:]*=env
        # leading silence: start right before the attack (keeps notes on time); loops keep absolute positions
        if not getattr(s,'keep_head',False):
            a0=np.abs(data) if data.ndim==1 else np.abs(data).max(axis=1)
            pk=a0.max() if len(a0) else 0
            if pk>0:
                first=int(np.argmax(a0>pk*0.004)); first=max(0,first-int(0.002*sr))
                if first>0: data=data[first:]
        # strip trailing silence
        a=np.abs(data) if data.ndim==1 else np.abs(data).max(axis=1)
        nz=np.nonzero(a>1e-4)[0]
        if len(nz): data=data[:max(nz[-1]+1, int(0.05*sr))]
        fn='%03d.ogg'%len(s.samples)
        sf.write(os.path.join(s.dir,fn),data.astype(np.float32),sr,format='OGG',subtype='VORBIS',compression_level=Q)
        s.bytes+=os.path.getsize(os.path.join(s.dir,fn))
        s.samples.append(fn); s.idx[keyid]=len(s.samples)-1
        return s.idx[keyid]
    def save(s):
        json.dump(dict(name=s.name,meta=s.meta,samples=s.samples,programs=s.programs),open(os.path.join(s.dir,'pack.json'),'w'),ensure_ascii=False,separators=(',',':'))
        print(s.name,len(s.samples),'samples',round(s.bytes/1e6,1),'MB')
def rd(p):
    d,sr=sf.read(p,dtype='float32',always_2d=True); return d,sr
def fl(r,k,dflt=0.0):
    try: return float(r.get(k,dflt))
    except: return dflt
def sfz_region(r,sidx,extra=None):
    o=dict(lk=key(r.get('lokey',r.get('key',0))),hk=key(r.get('hikey',r.get('key',127))),lv=int(r.get('lovel',1)),hv=int(r.get('hivel',127)),s=sidx,
           root=key(r.get('pitch_keycenter',r.get('key',60))),tune=fl(r,'tune'),vol=fl(r,'volume'),pan=fl(r,'pan')/100,
           att=fl(r,'ampeg_attack',0.001),hold=fl(r,'ampeg_hold'),dec=fl(r,'ampeg_decay'),sus=fl(r,'ampeg_sustain',100)/100,rel=fl(r,'ampeg_release',0.05))
    if r.get('trigger')=='release': o['trig']='r'
    if extra: o.update(extra)
    return o

def piano():
    p=Pack('piano',dict(title='Salamander Grand Piano V3 (Yamaha C5)',author='Alexander Holm',license='CC-BY 3.0',url='https://github.com/sfzinstruments/SalamanderGrandPiano'))
    base=EXT+'/SalamanderGrandPiano/Samples/'
    names=['A0','C1','D#1','F#1','A1','C2','D#2','F#2','A2','C3','D#3','F#3','A3','C4','D#4','F#4','A4','C5','D#5','F#5','A5','C6','D#6','F#6','A6','C7','D#7','F#7','A7','C8']
    layers=[(3,1,40),(7,41,66),(10,67,90),(13,91,112),(16,113,127)]
    regs=[]
    for i,nm in enumerate(names):
        root=key(nm); lk=21 if i==0 else root-1; hk=108 if i==len(names)-1 else root+1
        trim=7 if root<48 else 5 if root<72 else 3.5
        for v,lv,hv in layers:
            d,sr=rd(base+'%sv%d.flac'%(nm,v))
            si=p.add((nm,v),d,sr,trim=trim,fade=0.6)
            regs.append(dict(lk=lk,hk=hk,lv=lv,hv=hv,s=si,root=root,tune=0,vol=0,pan=0,att=0.001,hold=0,dec=0,sus=1,rel=0.35))
    p.programs['grand']=dict(name='Концертный рояль',regions=regs,vt=0.75,oneshot=True)
    p.save()
def egtr():
    p=Pack('egtr',dict(title='Emilyguitar (Epiphone, DI)',author='Karoryfer Lecolds (D. Smolken)',license='CC0 1.0',url='https://github.com/sfzinstruments/karoryfer.emilyguitar'))
    rs=sfz.load(EXT+'/karoryfer.emilyguitar/emily_basic.sfz')
    notes=[];dead=[];rel=[]
    rrcount=collections.Counter()
    for r in rs:
        smp=r.get('sample','').replace('\\','/')
        if not os.path.exists(r.get('_path','')): continue
        k=key(r.get('pitch_keycenter',r.get('lokey')))
        if r.get('trigger')=='release':
            if 'rr1' not in smp: continue
            d,sr=rd(r['_path']); si=p.add(smp,d,sr); rel.append(sfz_region(r,si,dict(trig='r')))
            continue
        if smp.startswith('noises/'):
            if not re.search(r'muted\d_rr[12]\.',smp) and not re.search(r'pickrest1_rr1',smp): continue
            d,sr=rd(r['_path']); si=p.add(smp,d,sr)
            reg=sfz_region(r,si); reg['rr']=smp; dead.append(reg); continue
        m=re.search(r'_rr(\d)',smp)
        if m and int(m.group(1))>2: continue
        d,sr=rd(r['_path']); si=p.add(smp,d,sr,trim=4.5)
        reg=sfz_region(r,si); reg['rr']=int(m.group(1)) if m else 1; notes.append(reg)
    for g in (notes,):
        cnt=collections.Counter((x['lk'],x['lv']) for x in g)
        for x in g: x['rrn']=cnt[(x['lk'],x['lv'])]
    p.programs['notes']=dict(name='Электрогитара DI',regions=notes+rel,vt=0.6,oneshot=True)
    # dead notes: keys 91..95 are muted strums -> map them to the whole range, round-robin
    dz=[x for x in dead if 'muted' in str(x.get('rr'))]
    for i,x in enumerate(dz): x.update(lk=0,hk=127,rr=i+1,rrn=len(dz),root=None)
    p.programs['dead']=dict(name='Глухие ноты',regions=dz,vt=0.5,oneshot=True)
    p.save()
def agtr():
    p=Pack('agtr',dict(title='Martin acoustic guitar (Discord SFZ GM)',author='Jeff Learman',license='CC0 1.0',url='https://github.com/sfzinstruments/Discord-SFZ-GM-Bank'))
    rs=sfz.load(EXT+'/dgm/Discord GM/Melodic/026-Acoustic Guitar (steel).sfz'); regs=[]
    for r in rs:
        d,sr=rd(r['_path']); si=p.add(r['sample'],d,sr,trim=6)
        x=sfz_region(r,si); x['sus']=1; x['dec']=0; x['hold']=0; x['rel']=0.25; regs.append(x)
    p.programs['steel']=dict(name='Акустическая гитара (Martin)',regions=regs,vt=0.7,oneshot=True)
    p.save()
def rhodes():
    p=Pack('rhodes',dict(title='jRhodes3c (Discord SFZ GM)',author='Jeff Learman',license='CC0 1.0',url='https://github.com/sfzinstruments/Discord-SFZ-GM-Bank'))
    rs=sfz.load(EXT+'/dgm/Discord GM/Melodic/005-Electric Piano 1.sfz'); regs=[]
    for r in rs:
        d,sr=rd(r['_path']); si=p.add(r['sample'],d,sr,trim=7,fade=0.8)
        x=sfz_region(r,si); x['sus']=1; x['dec']=0; x['hold']=0; regs.append(x)
    p.programs['rhodes']=dict(name='Rhodes',regions=regs,vt=0.8,oneshot=True)
    p.save()
def bass():
    p=Pack('bass',dict(title='Growlybass (Squier Jazz Bass, DI)',author='Karoryfer Lecolds',license='CC0 1.0',url='https://github.com/sfzinstruments/karoryfer.growlybass'))
    def take(fn,want):
        out=[]
        for r in sfz.load(EXT+'/growly/'+fn):
            smp=r.get('sample','').replace('\\','/')
            if not smp.startswith(want): continue
            m=re.search(r'_rr(\d)',smp)
            if m and int(m.group(1))>(1 if want=='release' else 2): continue
            d,sr=rd(r['_path']); si=p.add(smp,d,sr,trim=6)
            x=sfz_region(r,si); x['rr']=int(m.group(1)) if m else 1
            if want=='release': x['trig']='r'
            out.append(x)
        cnt=collections.Counter((x['lk'],x['lv'],x.get('trig')) for x in out)
        for x in out: x['rrn']=cnt[(x['lk'],x['lv'],x.get('trig'))]
        return out
    rel=take('growlybass_dirty.sfz','release')
    p.programs['finger']=dict(name='Бас: пальцы',regions=take('growlybass_dirty.sfz','sustain')+rel,vt=0.6,oneshot=True)
    p.programs['muted']=dict(name='Бас: приглушённый',regions=take('growlybass_vicious.sfz','staccato'),vt=0.6,oneshot=True)
    p.save()
def kit():
    p=Pack('kit',dict(title='Virtuosity Drums (премикс: бочка, малый, оверхеды)',author='Virtuosity Musical Instruments / Austin McMahon',license='CC0 1.0',url='https://github.com/sfzinstruments/virtuosity_drums'))
    rs=sfz.load(EXT+'/virtuosity_drums/Programs/01-basic-kit.sfz')
    by=collections.defaultdict(lambda: collections.defaultdict(list))
    for r in rs:
        k=r.get('key')
        if not k or not os.path.exists(r.get('_path','')): continue
        by[int(k)][(int(r.get('lovel',1)),int(r.get('seq_position',1)))].append(r)
    # GM note -> (source key, tune semitones)
    # GM 37 Side Stick = cross-stick (в базовой раскладке набора на 37 — другой удар): собираем из файлов cross-stick
    import glob
    cs=collections.defaultdict(list)
    for mic in ('kickmic','snaremic','oh'):
        for f in glob.glob(EXT+'/virtuosity_drums/Samples/%s/snare/%s_snare_crossstick_vl*.flac'%(mic,mic)):
            vl=int(re.search(r'_vl(\d+)',f).group(1)); cs[vl].append(f)
    nv=max(cs) if cs else 0
    by[1037]={}
    for vl in sorted(cs):
        lv=1+round((vl-1)*127/nv)
        by[1037][(lv,1)]=[dict(_path=f,volume='0',ampeg_release='0.3') for f in cs[vl]]
    gm={35:(35,0),36:(36,0),37:(1037,0),38:(38,0),40:(40,0),41:(41,-2),43:(41,0),45:(48,-3),47:(48,-1.5),48:(48,0),50:(48,2),
        42:(42,0),44:(44,0),46:(46,0),49:(49,0),51:(51,0),53:(53,0),54:(54,0),56:(56,0),57:(57,0),58:(58,0),59:(59,0)}
    for k in range(60,85): gm[k]=(k,0)
    regs=[]
    for g,(src,tune) in sorted(gm.items()):
        if src not in by: continue
        layers=by[src]
        vels=sorted(set(lv for lv,_ in layers))
        # keep at most 5 velocity layers, spread over the range
        if len(vels)>4: vels=[vels[round(i*(len(vels)-1)/3)] for i in range(4)]
        for vi,lv in enumerate(vels):
            nl=len(vels); lo=1+round(vi*127/nl); hv=round((vi+1)*127/nl)
            for rr in (1,2):
                grp=layers.get((lv,rr)) or (layers.get((lv,1)) if rr==1 else None)
                if not grp: continue
                mix=None; sr0=None
                for r in grp:
                    d,sr=rd(r['_path']); sr0=sr
                    if d.shape[1]==1: d=np.repeat(d,2,axis=1)
                    amp=10**(fl(r,'volume')/20)
                    if mix is None: mix=d*amp
                    else:
                        n=max(len(mix),len(d)); m2=np.zeros((n,2),np.float32); m2[:len(mix)]+=mix; m2[:len(d)]+=d*amp; mix=m2
                peak=np.abs(mix).max()
                if peak>0.98: mix*=0.98/peak
                si=p.add((src,lv,rr),mix,sr0,trim=4 if src in (49,51,55,57,59,53) else 2.5 if src==46 else 1.6,fade=0.4)
                r=grp[0]
                regs.append(dict(lk=g,hk=g,lv=lo,hv=hv,s=si,root=g-tune if tune else g,src=src if src<1000 else 37,tune=0,vol=0,pan=0,att=0.001,hold=0,dec=0,sus=1,rel=fl(r,'ampeg_release',0.4),rr=rr,rrn=2 if layers.get((lv,2)) else 1,
                                 excl=1 if g in (42,44,46) else 0))
    p.programs['kit']=dict(name='Живая установка',regions=regs,vt=0.9,oneshot=True,drum=True)
    p.save()
def gm():
    p=Pack('gm',dict(title='GeneralUser GS v2.0',author='S. Christian Collins',license='GeneralUser GS License v2.0 (свободное использование, в т.ч. в приложениях)',url='https://github.com/mrbumpy409/GeneralUser-GS'))
    f=SF2(EXT+'/gu/GeneralUser-GS.sf2'); p.keep_head=True
    want={(0,i):str(i) for i in range(128)}; want[(128,0)]='drums'
    pres={(b,pr):i for b,pr,nm,i in f.presets()}
    tc=lambda v: 2**(v/1200)
    for (b,pr),name in want.items():
        pi=pres[(b,pr)]; regs=[]
        for g in f.preset_regions(pi):
            sm=f.sample(g[53])
            st=sm['start']+g.get(0,0)+32768*g.get(4,0); en=sm['end']+g.get(1,0)+32768*g.get(12,0)
            ls=sm['ls']+g.get(2,0)+32768*g.get(45,0); le=sm['le']+g.get(3,0)+32768*g.get(50,0)
            mode=g.get(54,0)&3
            raw=np.frombuffer(f.pcm(st,en),dtype='<i2').astype(np.float32)/32768
            if len(raw)<8: continue
            si=p.add((st,en),raw,sm['sr'])
            root=g.get(58,-1); root=sm['root'] if root<0 else root
            tune=g.get(51,0)*100+g.get(52,0)+sm['corr']
            att=g.get(48,0)
            fc=g.get(8,13500)
            reg=dict(lk=g[43][0],hk=g[43][1],lv=g[44][0],hv=g[44][1],s=si,root=root,tune=tune,vol=-att/10*0.4,pan=max(-1,min(1,g.get(17,0)/500)),
                     att=tc(g.get(34,-12000)),hold=tc(g.get(35,-12000)),dec=tc(g.get(36,-12000)),sus=10**(-max(0,g.get(37,0))/200),rel=min(8,tc(g.get(38,-12000))),
                     ks=g.get(56,100))
            if mode in (1,3) and le>ls: reg['loop']=[round((ls-st)/sm['sr'],6),round((le-st)/sm['sr'],6)]
            if fc<13500: reg['fc']=round(8.176*2**(fc/1200))
            if g.get(57): reg['excl']=g[57]
            if g.get(40): reg['kd']=g[40]
            regs.append(reg)
        p.programs[name]=dict(name=f.phdr[pi][0].split(b'\0')[0].decode('latin1'),regions=regs,vt=1.0,sf2=True,drum=(b==128))
    p.save()
for fn in [piano,egtr,agtr,rhodes,bass,kit,gm]:
    if not only or fn.__name__ in only: fn()
