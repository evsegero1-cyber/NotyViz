# Minimal SFZ parser: headers, opcodes, #define, #include. Returns flat list of regions (dict of opcodes, inherited).
import os, re, sys, json
def load(path):
    base=os.path.dirname(path); defs={}
    def read(p, depth=0):
        txt=open(p,encoding='utf-8',errors='replace').read()
        txt=re.sub(r'//[^\n]*','',txt)
        out=[]
        for line in txt.split('\n'):
            m=re.match(r'\s*#define\s+(\$\w+)\s+(\S+)',line)
            if m: defs[m.group(1)]=m.group(2); continue
            # includes may be inline
            def inc(mm):
                q=os.path.join(base,mm.group(1).replace('\\','/'))
                return read(q,depth+1) if os.path.exists(q) else ''
            line=re.sub(r'#include\s+"([^"]+)"',inc,line)
            out.append(line)
        return '\n'.join(out)
    txt=read(path)
    for _ in range(3):
        for k in sorted(defs,key=len,reverse=True): txt=txt.replace(k,defs[k])
    toks=re.split(r'(<\w+>)',txt)
    levels={'control':{},'global':{},'master':{},'group':{}}
    regions=[]; cur=None; hdr=None
    order=['global','master','group','region']
    for t in toks:
        m=re.match(r'<(\w+)>',t)
        if m:
            hdr=m.group(1)
            if hdr in levels:
                idx=order.index(hdr) if hdr in order else -1
                levels[hdr]={}
                for o in order[idx+1:-1]: levels[o]={}
            if hdr=='region':
                cur={}; regions.append(cur)
            continue
        if hdr is None: continue
        # opcodes: key=value, value may contain spaces until next key=
        for mm in re.finditer(r'(\w+)=(.*?)(?=\s+\w+=|\s*$)',t.strip(),re.S):
            k,v=mm.group(1),mm.group(2).strip()
            if hdr=='region': cur[k]=v
            elif hdr in levels: levels[hdr][k]=v
        if hdr=='region':
            full={}
            for o in ['control','global','master','group']: full.update(levels[o])
            full.update(cur); regions[-1]=full; cur=full
    for r in regions:
        dp=r.get('default_path','')
        if 'sample' in r: r['_path']=os.path.normpath(os.path.join(base,(dp+r['sample']).replace('\\','/')))
    return regions
if __name__=='__main__':
    rs=load(sys.argv[1]); print(len(rs)); 
    for r in rs[:int(sys.argv[2]) if len(sys.argv)>2 else 5]: print(json.dumps(r,ensure_ascii=False))
