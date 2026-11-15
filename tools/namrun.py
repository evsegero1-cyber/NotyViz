import sys, types, json, time
class _Fake(types.ModuleType):
    def __getattr__(self, k):
        if k.startswith('__'): raise AttributeError(k)
        return type(k, (), {'__init__': lambda *a, **kw: None})
for _n in ['tkinter','tkinter.filedialog','tkinter.ttk','tkinter.messagebox','tkinter.font','tkinter.simpledialog','tkinter.scrolledtext','tkinter.constants']:
    sys.modules[_n] = _Fake(_n)
sys.modules['tkinter'].filedialog = sys.modules['tkinter.filedialog']; sys.modules['tkinter'].ttk = sys.modules['tkinter.ttk']; sys.modules['tkinter'].messagebox = sys.modules['tkinter.messagebox']
import numpy as np, torch
from nam.models import init_from_nam
torch.set_grad_enabled(False)
def load(path):
    m = init_from_nam(json.load(open(path))); m.eval(); return m
def run(m, x):
    t = torch.tensor(x, dtype=torch.float32)
    y = m(t, pad_start=True) if 'pad_start' in m.forward.__code__.co_varnames else m(t)
    return y.numpy().astype(np.float64)
if __name__ == '__main__':
    m = load(sys.argv[1]); x = (np.random.randn(48000*3)*0.1)
    t0=time.time(); y=run(m,x); print('3 s audio in', round(time.time()-t0,2),'s', y.shape, float(np.abs(y).max()))
