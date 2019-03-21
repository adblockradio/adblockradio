import python_speech_features as psf
import numpy as np
import json

from scipy.fftpack import dct

sampleRate = 22050 # in Hz
mfccStepT = 0.02  # in seconds. generate cepstral coefficients every N seconds.
mfccWinlen = 0.05  # in seconds. use N seconds of audio data to compute cepstral coefficients
mfccNceps = 13 # amount of cepstral coefficients at each time step.

winfunc = lambda x:np.ones((x,))

results = {}

# read PCM and test we import it correctly
data = np.memmap("vousavezducourrier.pcm", dtype='int16', mode='r')
pcm = np.frombuffer(data, dtype="int16")
print("%s samples" % len(pcm))
print("First sample is %s" % pcm[0])
results['samples'] = len(pcm)
results['firstSample'] = pcm.tolist()[0]

# test pre-emphasis calculations. only output the first 100 samples.
preemph = psf.sigproc.preemphasis(pcm,0.97)
results['preemph'] = preemph[0:100].tolist()

# test signal framing
frames = psf.sigproc.framesig(preemph, mfccWinlen*sampleRate, mfccStepT*sampleRate, winfunc)
results['frames'] = frames[0:10].tolist()

# test power spectrum (the first one at least)
powspec = psf.sigproc.powspec(frames, 2048)
results['powspec'] = powspec[0].tolist()

# test filterbank
hz2mel = lambda hz : 2595 * np.log10(1+hz/700.)
mel2hz = lambda mel : 700*(10**(mel/2595.0)-1)
highMel = hz2mel(sampleRate/2)
#print("highMel = %s" % highMel)
melpoints = np.linspace(0,highMel,26+2)
results['bins'] = np.floor((2048+1)*mel2hz(melpoints)/sampleRate).tolist()
filterbank = psf.get_filterbanks(nfilt=26,nfft=2048,samplerate=sampleRate,lowfreq=0,highfreq=None)
results['filters'] = filterbank.tolist()
feat,energy = psf.fbank(pcm,sampleRate,mfccWinlen,mfccStepT,26,2048,0,None,0.97,winfunc)
results['feat'] = feat.tolist()
results['energy'] = energy.tolist()

# test dct
results['dct'] = dct(np.log(feat), type=2, axis=1, norm='ortho')[:,:mfccNceps].tolist()

# test mfcc
ceps = psf.mfcc(
	pcm,
	samplerate=sampleRate,
	winlen=mfccWinlen,
	winstep=mfccStepT,
	numcep=mfccNceps,
	nfilt=26,
	nfft=2048,
	lowfreq=0,
	highfreq=None,
	preemph=0.97,
	ceplifter=22,
	appendEnergy=True
)

#print('Got %s series of %s cepstra coefficients' % (len(ceps), len(ceps[0])))

results['nwin'] = len(ceps)
results['nceps'] = len(ceps[0])
results['ceps'] = ceps.tolist()

# save results
with open('py.json', 'w') as outfile:
	json.dump(results, outfile)