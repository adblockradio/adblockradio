# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Copyright (c) 2018 Alexandre Storelli

import sys
import os
import datetime
import json
import numpy as np
import math
import sounddevice as sd
import python_speech_features as psf
import audioop
os.environ["PBR_VERSION"]='3.1.1'
from keras.models import load_model
os.environ['TF_CPP_MIN_LOG_LEVEL']='2' # reduce log spam from tensorflow. cf https://github.com/tensorflow/tensorflow/issues/7778
import tensorflow as tf		# https://groups.google.com/forum/#!topic/keras-users/MFUEY9P1sc8
from keras.backend import clear_session, tensorflow_backend
import psutil
import zerorpc
import logging

### CONFIG

# show or hide verbose logging
debug = False

# play audio as received by this module.
# causes lags in the process. for debugging purposes.
playAudio = False

mfccStepT = 0.02  # in seconds. generate cepstral coefficients every N seconds.
mfccWinlen = 0.05  # in seconds. use N seconds of audio data to compute cepstral coefficients
mfccNceps = 13 # amount of cepstral coefficients at each time step.

nnXLenT = 4.0  # window of data intake, in seconds
nnXLen = int(round(nnXLenT / mfccStepT))  # data intake in points
nnXStepT = 0.19*4 # compute one LSTM prediction every N seconds.
nnXStep = int(round(nnXStepT / mfccStepT)) # amount of cepstral spectra read for each LSTM prediction

### END OF CONFIG

logging.basicConfig(format='%(asctime)s %(message)s') # https://github.com/0rpc/zerorpc-python/issues/79
logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG if debug is True else logging.WARN)

process = psutil.Process(os.getpid())

#import cProfile
from timeit import default_timer as timer

# if GPU accelerated, limit the amount of memory allocated
def get_session(gpu_fraction=0.05):
	num_threads = os.environ.get('OMP_NUM_THREADS')
	gpu_options = tf.GPUOptions(per_process_gpu_memory_fraction=gpu_fraction)

	if num_threads:
		return tf.Session(config=tf.ConfigProto(gpu_options=gpu_options, intra_op_parallelism_threads=num_threads))
	else:
		return tf.Session(config=tf.ConfigProto(gpu_options=gpu_options))

tensorflow_backend.set_session(get_session())

radio = sys.argv[1]
logger.debug("radio: " + radio)

class MlPredictor(object):
	def __init__(self): #, radio, fileModel, sampleRate, bitdepth):
		self.radio = radio
		self.sampleRate = 22050 # Hz
		self.nchannels = 1 # single channel only
		self.bitdepth = 16 / 8 # 16 bit audio only, 2 bytes per sample
		self.bitrate = self.sampleRate * self.nchannels * self.bitdepth # in bytes / s
		self.pcm = None
		self.buf = []
		self.model = None

	def load(self, fileModel):
		# utf8 encoding prevents an error in Keras: TypeError: Required Group, str or dict. Received: <type 'unicode'>.
		fileModel = fileModel.encode('utf8')
		if os.path.isfile(fileModel):
			logger.debug(u"load model from file %s", fileModel)
			if self.model is not None:
				clear_session()
				del self.model
			self.model = load_model(fileModel)
			logger.info("model loaded")
			return True
		else:
			fileModelSplit = fileModel.split("/")
			fileModelSplit[-1] = "all.keras"
			defaultFileModel = "/".join(fileModelSplit)
			logger.info(u"default file %s", defaultFileModel)

			if os.path.isfile(defaultFileModel):
				logger.info("load default model from file.")
				if self.model is not None:
					clear_session()
					del self.model
				self.model = load_model(defaultFileModel)
				logger.info("model loaded")
				return True
			else:
				logger.error("Model not found")
				raise Exception("model not found")


	def write(self, data):
		self.buf.append(data) # = data if self.buf is None else np.append(self.buf, data) # or self.buf + data

	def predict(self):
		if (len(self.buf) == 0):
			logger.debug("request to predict, but no (new) data to process. abort.")
			raise Exception("no data to process")

		if (self.model is None):
			logger.debug("request to predict, but no model is loaded. please do it first. abort.")
			raise Exception("no model loaded")

		data = ''.join(self.buf)
		self.buf = []

		duration = 1.0 * len(data) / self.bitrate
		logger.debug("py received " + str(duration) + " s (" + str(len(data)) + " bytes)")

		if playAudio:
			sd.play(np.frombuffer(data, dtype="int16"), self.sampleRate)

		#t0 = timer()

		# compute the rms (root mean square) in dB
		try:
			rms = 20 * math.log10(audioop.rms(data, 2))
		except:
			rms = 70
			logger.info("invalid rms=" + str(audioop.rms(data, 2)) + " data len=" + str(len(data)))
			pass

		tmp = np.frombuffer(data, dtype="int16") # single channel only

		self.pcm = tmp if self.pcm is None else np.append(self.pcm, tmp)

		#t1 = timer()
		pcm_len_limit = int((nnXLenT + duration) * self.sampleRate)
		if len(self.pcm) > pcm_len_limit:
			logger.debug("need to truncate pcm from " + str(len(self.pcm)) + " to " + str(pcm_len_limit))
			self.pcm = self.pcm[-pcm_len_limit:]

		# compute a series of mel-frequency cepstral coefficients
		ceps = psf.mfcc(
			self.pcm,
			samplerate=self.sampleRate,
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

		#t2 = timer()
		if ceps.shape[0] < nnXLen:  # audio input is shorter than LSTM window
			prevshape = ceps.shape
			ceps = np.pad(ceps, ((nnXLen-ceps.shape[0], 0),(0,0)), 'edge')
			logger.debug("ceps extended from " + str(prevshape) + " to " + str(ceps.shape))


		nframes = ceps.shape[0]
		nwin = int(math.floor((nframes-nnXLen) / nnXStep))+1
		t = [1.*nnXLenT/2 + nnXStepT*i for i in range(nwin)]
		logger.debug("ceps.shape " + str(ceps.shape) + " nnXLen " + str(nnXLen) + " nnXStep " + str(nnXStep) + " nwin " + str(nwin))
		X = np.empty([nwin, nnXLen, mfccNceps])

		for i in range(nwin):
			X[i,:,:] = ceps[i*nnXStep:(i*nnXStep+nnXLen),:]
		#t3 = timer()

		predictions = self.model.predict(X, verbose=debug)

		#t4 = timer()

		mp = np.mean(predictions, axis=0)
		mp_ref = np.array(mp, copy=True)
		predclass = np.argmax(mp)
		mp.sort()
		confidence = 1.0-math.exp(1-mp[2]/mp[1])
		logger.debug("mpref " + str(mp_ref))
		logger.debug("mp " + str(mp))
		logger.debug("confidence " + str(confidence))
		logger.debug("rms " + str(rms))

		#t5 = timer()
		result = json.dumps({
			'type': predclass,
			'data': predictions.tolist(),
			'confidence': confidence,
			'softmax': mp_ref.tolist(),
			'rms': rms,
			'mem': process.memory_info().rss,
			'lenpcm': len(self.pcm),
			#'timings': {'pre': str(t3-t0), 'tf': str(t4-t3), 'post': str(t5-t4), 'total': str(t5-t0)},
			'nwin': nwin
		})

		logger.info("audio predicted probs=" + result)
		#logger.info("pre=%s ms tf=%s ms post=%s ms total=%s ms" % (t3-t0, t4-t3, t5-t4, t5-t0))
		return result

	def exit(self):
		sys.exit()


s = zerorpc.Server(MlPredictor())
s.bind("ipc:///tmp/" + radio)
s.run()