# Adblock Radio

## Outline
This module analyses radio streams and determines if current kind of audio is advertisement, talk or music in audio streams

The analysis is two-fold:

First, in `predictor.js`, the audio stream is downloaded with the module [dest4/stream-tireless-baler](https://github.com/dest4/stream-tireless-baler) then decoded with `ffmpeg`.
PCM audio is piped into two sub-modules:
- a time-frequency analyser (`predictor-ml/ml.js`), that identifies patterns in spectrograms with machine learning.
- a fingerprint matcher (`predictor-db/hotlist.js`), that searches for exact occurrences of known audio samples (using module [dest4/stream-audio-fingerprint](https://github.com/dest4/stream-audio-fingerprint))

Then, in `post-processing.js`, results are gathered for each audio segment. The audio buffer is leveraged to smooth the results and prune dubious predictions.
A Readable interface, `Analyser`, is exposed. It streams objects containing the audio itself and all analysis results.

## Getting started

### Installation

First, get Node.js and NPM. Tested with node v9.9.0 and NPM 5.6.0. If you need to manage several node versions on your workstation, use [NVM](https://github.com/creationix/nvm).
```
git clone https://github.com/dest4/adblockradio.git
cd adblockradio
npm install
```

### Demo

The time-frequency analyser need a compatible machine-learning model. The fingerprint matcher need a fingerprint database.
Grab demo files for French station Radio FG with the following commands:
```
cd model/
wget https://www.adblockradio.com/models/France_RTL.keras
wget https://www.adblockradio.com/models/France_RTL.sqlite
cd ..
```

then run the demo:
```
const { log } = require("abr-log")("demo");
const { Analyser } = require("./post-processing.js");

log.info("start analyser!");

const abr = new Analyser({
	country: "France",
	name: "RTL",
	config: {
		predInterval: 1,
		saveDuration: 10,
		enablePredictorHotlist: true,
		enablePredictorMl: true,
		saveAudio: true,
		saveMetadata: true,
		fetchMetadata: true
	}
});

abr.on("data", function(obj) {
	log.info("status=" + JSON.stringify(Object.assign(obj, { audio: undefined }), null, "\t"));
});
```
or

```
node demo.js
```


Here is a sample output of the demo script:
```
[2018-07-09T15:29:30.730Z] info demo: 	status={
	"gain": 74.63,
	"ml": {
		"class": "0-ads",
		"softmaxraw": [
			0.996,
			0.004,
			0
		],
		"softmax": [
			0.941,
			0.02,
			0.039
		],
		"slotsFuture": 4,
		"slotsPast": 5
	},
	"hotlist": {
		"class": "unsure",
		"file": null,
		"matches": 1,
		"total": 7
	},
	"class": "0-ads",
	"metadata": {
		"artist": "Laurent Ruquier",
		"title": "L'été des Grosses Têtes",
		"cover": "https://cdn-media.rtl.fr/cache/wQofzw9SfgHNHF1rqJA3lQ/60v73-2/online/image/2014/0807/7773631957_laurent-ruquier.jpg"
	},
	"streamInfo": {
		"url": "http://streaming.radio.rtl.fr/rtl-1-44-128",
		"favicon": "https://cdn-static.rtl.fr/versions/www/6.0.637/img/apple-touch-icon.png",
		"homepage": "http://www.rtl.fr/",
		"audioExt": "mp3"
	},
	"predictorStartTime": 1531150137583,
	"playTime": 1531150155250,
	"tBuffer": 15.98,
	"audioLen": 16000
}
```
## Documentation

Readable streams constructed with `Analyser` emit objects with the following properties.

- audio: Buffer containing a chunk of original (compressed) audio data.

- ml: null if not available, otherwise an object containing the results of the time-frequency analyser
  * class: either "0-ads", "1-speech" or "2-music". The classification according to this module.
  * softmaxraw: an array of three numbers representing the [softmax](https://en.wikipedia.org/wiki/Softmax_function) between ads, speech and music.
  * softmax: same as softmaxraw, but smoothed in time with `slotsFuture` data points in the future and `slotsPast` data points in the past. Smoothing weights are defined by `consts.MOV_AVG_WEIGHTS` in `post-processing.js`.

- hotlist: null if not available, otherwise an object containing the results of the fingerprint matcher.
  * class: either "0-ads", "1-speech", "2-music", "3-jingles" or "unsure"
  * file: if class is not "unsure", the reference of the file recognized.
  * total: number of fingerprints computed for the given audio segment.
  * matches: number of matching fingerprints between the audio segment and the fingerprint database.

- class: final prediction of the algorithm.

- metadata: live metadata using the module [dest4/webradio-metadata](https://github.com/dest4/webradio-metadata)

- streamInfo: static metadata about the stream. audio url, favicon, audio format (mp3 or aac) and homepage URL.

- gain: a dB-like value representing the average volume of the stream. Useful if you wish to normalize the playback volume. Calculated by [`mlpredict.py`](https://github.com/dest4/adblockradio/blob/master/predictor-ml/mlpredict.py).

- tBuffer: seconds of audio buffer. Calculated by [dest4/stream-tireless-baler](https://github.com/dest4/stream-tireless-baler).
  
- predictorStartTime: timestamp of the algorithm startup. Useful to get the uptime.

- playTime: approximate timestamp of when the given audio is to be played. TODO check this.  
  
  
  
  
