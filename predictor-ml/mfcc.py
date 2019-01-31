import python_speech_features as psf
import numpy as np

sampleRate = 22050 # in Hz
mfccStepT = 0.02  # in seconds. generate cepstral coefficients every N seconds.
mfccWinlen = 0.05  # in seconds. use N seconds of audio data to compute cepstral coefficients
mfccNceps = 13 # amount of cepstral coefficients at each time step.

# read PCM
data = np.memmap("vousavezducourrier.pcm", dtype='int16', mode='r')
pcm = np.frombuffer(data, dtype="int16")

# compute ceps
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

print ceps