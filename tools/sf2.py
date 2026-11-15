import struct, sys
GEN_NAMES={0:'startAddrsOffset',1:'endAddrsOffset',2:'startloopAddrsOffset',3:'endloopAddrsOffset',4:'startAddrsCoarseOffset',8:'initialFilterFc',9:'initialFilterQ',12:'endAddrsCoarseOffset',17:'pan',33:'delayVolEnv',34:'attackVolEnv',35:'holdVolEnv',36:'decayVolEnv',37:'sustainVolEnv',38:'releaseVolEnv',39:'keynumToVolEnvHold',40:'keynumToVolEnvDecay',41:'instrument',43:'keyRange',44:'velRange',45:'startloopAddrsCoarseOffset',48:'initialAttenuation',50:'endloopAddrsCoarseOffset',51:'coarseTune',52:'fineTune',53:'sampleID',54:'sampleModes',56:'scaleTuning',57:'exclusiveClass',58:'overridingRootKey'}
class SF2:
    def __init__(s,path):
        d=open(path,'rb').read(); s.d=d
        assert d[:4]==b'RIFF' and d[8:12]==b'sfbk'
        s.chunks={}
        def walk(o,end):
            while o<end:
                cid=d[o:o+4]; sz=struct.unpack('<I',d[o+4:o+8])[0]
                if cid==b'LIST': walk(o+12,o+8+sz)
                else: s.chunks[cid.decode('latin1')]=(o+8,sz)
                o+=8+sz+(sz&1)
        walk(12,len(d))
        o,sz=s.chunks['smpl']; s.smpl=(o,sz)
        def recs(name,fmt):
            o,sz=s.chunks[name]; n=struct.calcsize(fmt); return [struct.unpack(fmt,d[o+i*n:o+(i+1)*n]) for i in range(sz//n)]
        s.phdr=recs('phdr','<20sHHHIII'); s.pbag=recs('pbag','<HH'); s.pgen=recs('pgen','<HH')
        s.inst=recs('inst','<20sH'); s.ibag=recs('ibag','<HH'); s.igen=recs('igen','<HH')
        s.shdr=recs('shdr','<20sIIIIIBbHH')
    def gens(s,genlist,a,b):
        g={}
        for op,amt in genlist[a:b]:
            if op in (43,44): g[op]=(amt&255,amt>>8)
            else: g[op]=struct.unpack('<h',struct.pack('<H',amt))[0] if op not in (41,53) else amt
        return g
    def zones(s,hdrs,bags,genlist,idx,link):
        a=hdrs[idx][-1] if len(hdrs[idx])==2 else hdrs[idx][3]
        b=hdrs[idx+1][-1] if len(hdrs[idx])==2 else hdrs[idx+1][3]
        out=[];glob={}
        for bi in range(a,b):
            g=s.gens(genlist,bags[bi][0],bags[bi+1][0])
            if link not in g:
                if bi==a: glob=g
                continue
            out.append(g)
        return glob,out
    def presets(s):
        res=[]
        for i in range(len(s.phdr)-1):
            nm,prog,bank=s.phdr[i][0].split(b'\0')[0].decode('latin1'),s.phdr[i][1],s.phdr[i][2]
            res.append((bank,prog,nm,i))
        return res
    def preset_regions(s,pi):
        pg,pz=s.zones(s.phdr,s.pbag,s.pgen,pi,41)
        regs=[]
        for z in pz:
            pzg=dict(pg); pzg.update(z)
            ii=z[41]
            ig,iz=s.zones(s.inst,s.ibag,s.igen,ii,53)
            for zz in iz:
                g=dict(ig); g.update(zz)
                # preset generators add (except ranges)
                for op,v in pzg.items():
                    if op in (41,43,44,53,58,54,57,0,1,2,3,4,12,45,50): continue
                    g[op]=g.get(op,0)+v
                # ranges intersect
                for op in (43,44):
                    lo1,hi1=g.get(op,(0,127)); lo2,hi2=pzg.get(op,(0,127))
                    g[op]=(max(lo1,lo2),min(hi1,hi2))
                if g[43][0]>g[43][1] or g[44][0]>g[44][1]: continue
                regs.append(g)
        return regs
    def sample(s,si):
        nm,start,end,ls,le,sr,root,corr,link,typ=s.shdr[si]
        return dict(name=nm.split(b'\0')[0].decode('latin1'),start=start,end=end,ls=ls,le=le,sr=sr,root=root,corr=corr,link=link,type=typ)
    def pcm(s,a,b):
        o,_=s.smpl; return s.d[o+2*a:o+2*b]
if __name__=='__main__':
    f=SF2(sys.argv[1])
    for p in f.presets(): print(p)
