import numpy as np
import time

urls = np.repeat(np.arange(160000), 2)  # 320,000 rows
feat_matrix = np.random.randn(320000, 26)
durs = np.random.randn(320000)
evts = np.random.randint(0, 2, 320000)

t0 = time.time()
changes = np.where(urls[:-1] != urls[1:])[0] + 1
splits = np.split(np.arange(len(urls)), changes)

seqs = []
out_durs = []
out_evts = []

for split in splits:
    profile_feats = feat_matrix[split]
    profile_durs = durs[split]
    profile_evts = evts[split]
    for i in range(len(split)):
        seqs.append(profile_feats[:i+1])
        out_durs.append(profile_durs[i])
        out_evts.append(profile_evts[i])
        
print("Time:", time.time() - t0)
