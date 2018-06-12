import sys
import os
import datetime
import json
import numpy as np
import math
import pyaudio
import python_speech_features as psf
import audioop
from keras.models import load_model
os.environ['TF_CPP_MIN_LOG_LEVEL']='2' # reduce log spam from tensorflow. cf https://github.com/tensorflow/tensorflow/issues/7778
import tensorflow as tf		# https://groups.google.com/forum/#!topic/keras-users/MFUEY9P1sc8
import keras.backend.tensorflow_backend as KTF
import psutil

process = psutil.Process(os.getpid())

#import cProfile
from timeit import default_timer as timer

pid = os.getpid()

def get_session(gpu_fraction=0.05):
	num_threads = os.environ.get('OMP_NUM_THREADS')
	gpu_options = tf.GPUOptions(per_process_gpu_memory_fraction=gpu_fraction)

	if num_threads:
		return tf.Session(config=tf.ConfigProto(gpu_options=gpu_options, intra_op_parallelism_threads=num_threads))
	else:
		return tf.Session(config=tf.ConfigProto(gpu_options=gpu_options))

KTF.set_session(get_session())



debug = False
playAudio = False # for debug only, causes some lags in the program

class bcolors:
    HEADER = '\033[95m'
    OKBLUE = '\033[94m'
    OKGREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    UNDERLINE = '\033[4m'

def log(msg, msgtype=" [INFO]  "):	print datetime.datetime.today().strftime('%m/%d-%H:%M-%S') + msgtype + str(pid) + " " + str(msg)
def logwarn(msg): return log(msg, msgtype= bcolors.WARNING + " [WARN]  " + bcolors.ENDC)
def logerror(msg): return log(msg, msgtype= bcolors.FAIL + " [ERROR] " + bcolors.ENDC)
if debug == True:
	def logdebug(msg): return log(msg, msgtype= bcolors.HEADER + " [DEBUG] " + bcolors.ENDC)
else:
	def logdebug(msg): return True

radio = sys.argv[1]
fileModel = sys.argv[2]
sampleRate = int(sys.argv[3])
nchannels = int(sys.argv[4])
bitdepth = int(sys.argv[5])
bitrate = sampleRate * nchannels * bitdepth / 8
#readAmount = int(bitrate * float(sys.argv[6]))
stopword = sys.argv[6]

mfccStepT = 0.02  # in seconds
mfccWinlen = 0.05  # in seconds
mfccNceps = 13
nnXLenT = 4.0  # window of data intake, in seconds
nnXLen = int(round(nnXLenT / mfccStepT))  # data intake in points
nnXStepT = 0.19*4
nnXStep = int(round(nnXStepT / mfccStepT))
pcm = None

#nsuicide = 0


# audio out for debug purposes
if playAudio:
	pyaud = pyaudio.PyAudio()
	audioout = pyaud.open(format=pyaud.get_format_from_width(bitdepth / 8), channels=nchannels, rate=sampleRate, output=True)


logdebug("radio: " + radio + " samplerate: " + str(sampleRate) + " channels: " + str(nchannels) + " bitdepth: " + str(bitdepth) + " bitrate: " + str(bitrate))

if os.path.isfile(fileModel):
	logdebug("load model from file.")
	model = load_model(fileModel)
	log("model loaded")
else:
	fileModelSplit = fileModel.split("/")
	fileModelSplit[-1] = "all.keras"
	defaultFileModel = "/".join(fileModelSplit)
	log("default file " + defaultFileModel)

	if os.path.isfile(defaultFileModel):
		log("load default model from file.")
		model = load_model(defaultFileModel)
		log("model loaded")
	else:
		logerror("Model not found, cannot tag audio")
		sys.exit()

stopwordlen = len(stopword)
stopwordindex = 0
ignoreamount = 0
partial = ""
pcm = None

while True:
	data = partial
	while True: # read until the stop word is read. this loop may be slow

		"""
		char = sys.stdin.read(1)

		if char == stopword[stopwordindex]: # stop word is being read
			logdebug("stop word: read " + char + " at stopwordindex " + str(stopwordindex))
			stopwordindex += 1
			if stopwordindex >= stopwordlen: # stop word is complete.
				logdebug("stop word complete!")
				stopwordindex = 0
				break
		elif stopwordindex > 0: # finally, it was not the stop word. add the beginning of the stopword to actual data.
			#for i in range(0, stopwordindex):
			logdebug("stop word false alarm, append " + stopword[0:stopwordindex])
			data += stopword[0:stopwordindex]
			stopwordindex = 0
		else:	# general case
			#logdebug("not recognized char: " + char)
			data += char
		"""

		chars = partial + sys.stdin.read(stopwordlen)
		pos = chars.find(stopword)
		if pos >= 0:
			logdebug("stop word detected at pos " + str(pos))
			data += chars[0:pos]
			partial = ""
			ignoreamount = stopwordlen*10 - pos + stopwordlen
			#partial = chars[pos+stopwordlen:]
			break
		elif ignoreamount >= len(chars):
			ignoreamount -= len(chars)
		else:
			data += chars[ignoreamount:len(chars)-stopwordlen]
			#data += chars[0:len(chars)-stopwordlen]
			ignoreamount = 0
			partial = chars[len(chars)-stopwordlen:len(chars)]

	# each audio sample uses 2 bytes. do not separate them
	if len(data) % 2 == 1:
		partial = data[len(data)-1] + partial
		data = data[0:len(data)-1]

	# to stop the program, send two consecutive stop words without data in between.
	if len(data) == 0:
		logdebug("empty data: stop")
		break

	#data = sys.stdin.read(readAmount)
	#if len(data) == 0:
	#	break

	duration = len(data)/bitrate
	logdebug("py received " + str(duration) + " s (" + str(len(data)) + " bytes)")
	if playAudio:
		audioout.write(data)
#	cProfile.run('processData(data)')

	t0 = timer()

	try:
		rms = 20*math.log10(audioop.rms(data,2))
	except:
		rms = 70
		log("invalid rms=" + str(audioop.rms(data,2)) + " data len=" + str(len(data)))
		pass

	if nchannels > 1: # only analyse the first channel (usually, for stereo signals, the left one)
		tmp = np.frombuffer(data, dtype="int16")[0::nchannels]
	else:
		tmp = np.frombuffer(data, dtype="int16")

	pcm = tmp if pcm is None else np.append(pcm, tmp)

	t1 = timer()
	pcm_len_limit = int((nnXLenT + duration) * sampleRate)
	if len(pcm) > pcm_len_limit:
		logdebug("need to truncate pcm from " + str(len(pcm)) + " to " + str(pcm_len_limit))
		pcm = pcm[-pcm_len_limit:]

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

	t2 = timer()
	if ceps.shape[0] < nnXLen:  # audio input is shorter than LSTM window
		prevshape = ceps.shape
		ceps = np.pad(ceps, ((nnXLen-ceps.shape[0], 0),(0,0)), 'edge')
		logdebug("ceps extended from " + str(prevshape) + " to " + str(ceps.shape))


	nframes = ceps.shape[0]  # one of the dims of ceps.shape
	nwin = int(math.floor((nframes-nnXLen) / nnXStep))+1
	t = [1.*nnXLenT/2 + nnXStepT*i for i in range(nwin)]
	logdebug("ceps.shape " + str(ceps.shape) + " nnXLen " + str(nnXLen) + " nnXStep " + str(nnXStep) + " nwin " + str(nwin))
	X = np.empty([nwin, nnXLen, mfccNceps])

	t3 = timer()
	for i in range(nwin):
		X[i,:,:] = ceps[i*nnXStep:(i*nnXStep+nnXLen),:]

	predictions = model.predict(X, verbose=debug)  # [:100, :, :]

	t4 = timer()

	mp = np.mean(predictions, axis=0)
	mp_ref = np.array(mp, copy=True)
	predclass = np.argmax(mp)
	mp.sort()
	confidence = 1.0-math.exp(1-mp[2]/mp[1])
	logdebug("mpref " + str(mp_ref))
	logdebug("mp " + str(mp))
	logdebug("confidence " + str(confidence))
	logdebug("rms " + str(rms))
	log("audio predicted probs=" + json.dumps({
		'type': predclass,
		'data': predictions.tolist(),
		'confidence': confidence,
		'softmax': mp_ref.tolist(),
		'rms': rms,
		'mem': process.memory_info().rss,
		'lenpcm': len(pcm),
		'timings': {'mfcc': str(t2-t1), 'inference': str(t4-t3)} })
	)
	#t5 = timer()
	#nsuicide = nsuicide + 1
	#if nsuicide > 4:
	#	raise ValueError('A very specific bad thing happened')
	#logdebug("12:" + str(t2-t1) + "  23:" + str(t3-t2) + "  34:" + str(t4-t3) + "  45:" + str(t5-t4) + "  15:" + str(t5-t1))
