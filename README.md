# Adblock Radio

## Outline
This module analyses radio streams and determines if current kind of audio is advertisement, talk or music in audio streams. It is the engine of [Adblock Radio](https://www.adblockradio.com).

The analysis is two-fold:

First, in `predictor.js`, the audio stream is downloaded with the module [dest4/stream-tireless-baler](https://github.com/dest4/stream-tireless-baler) then decoded with `ffmpeg`.
PCM audio is piped into two sub-modules:
- a time-frequency analyser (`predictor-ml/ml.js`), that identifies patterns in spectrograms with machine learning.
- a fingerprint matcher (`predictor-db/hotlist.js`), that searches for exact occurrences of known audio samples (using module [dest4/stream-audio-fingerprint](https://github.com/dest4/stream-audio-fingerprint))

Then, in `post-processing.js`, results are gathered for each audio segment. The audio buffer is leveraged to smooth the results and prune dubious predictions.
A Readable interface, `Analyser`, is exposed. It streams objects containing the audio itself and all analysis results.

## Getting started

### Installation

As prerequisites, you need:
- Node.js and NPM. This project has been tested with node v9.9.0 and NPM 5.6.0. If you need to manage several node versions on your platform, you might want to use [NVM](https://github.com/creationix/nvm).
- Python (tested with v2.7.9).
- Keras (tested with v2.0.8). Keras installation instructions are available [here](https://keras.io/#installation).
- Tensorflow (tested with `tensorflow` v1.4.0 and `tensorflow-gpu` v1.3.0). Installation instructions are [here](https://www.tensorflow.org/install/).
- FFmpeg (tested with v2.6.9). Installation instructions available [here](https://ffmpeg.org/download.html).

Then install this module:

```bash
git clone https://github.com/dest4/adblockradio.git
cd adblockradio
npm install
```

### Demo

The time-frequency analyser needs a compatible machine-learning model (`*.keras`). The fingerprint matcher needs a fingerprint database (`*.sqlite`).
Grab demo files for French station RTL with the following commands: (TODO)
```bash
cd model/
wget https://www.adblockradio.com/models/France_RTL.keras
wget https://www.adblockradio.com/models/France_RTL.sqlite
cd ..
```

then run the demo:
```bash
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
	"audio": ...
}
```

## Documentation

### Usage

```javascript
const { Analyser } = require("adblockradio");

const abr = new Analyser({
	country: "France",
	name: "RTL",
	config: {
		...
	}
});

abr.on("data", function(obj) {
	...
});
```

Property|Description|Default
--------|-----------|-------
`country`|Country of the radio stream according to [radio-browser.info](http://www.radio-browser.info)|None
`name`|Name of the radio stream according to [radio-browser.info](http://www.radio-browser.info)|None


### Optional configuration

#### Stream segmentation

Property|Description|Default
--------|-----------|-------
`predInterval`|send stream status to listener every N seconds|`1`
`saveDuration`|save audio file and metadata every N `predInterval` times|`10`

#### Switches

Property|Description|Periodicity|Default
--------|-----------|-----------|-------
`enablePredictorMl`|perform machine learning inference|`predInterval`|`true`
`enablePredictorHotlist`|compute audio fingerprints and search them in a DB|`predInterval`|`true`
`saveAudio`|save stream audio data in segments on hard drive|`saveDuration`|`true`
`saveMetadata`|save a JSON with predictions|`saveDuration`|`true`
`fetchMetadata`|gather metadata from radio websites|`saveDuration`|`true`

#### Paths

Property|Description|Default
--------|-----------|-------
`modelPath`|directory where ML models and hotlist DBs are stored|`__dirname + '/model'`
`saveAudioPath`|root folder where audio and metadata are saved|`__dirname + '/records'`

### Output

Readable streams constructed with `Analyser` emit objects with the following properties.

- `audio`: Buffer containing a chunk of original (compressed) audio data.

- `ml`: `null` if not available, otherwise an object containing the results of the time-frequency analyser
  * `class`: either `0-ads`, `1-speech` or `2-music`. The classification according to this module.
  * `softmaxraw`: an array of three numbers representing the [softmax](https://en.wikipedia.org/wiki/Softmax_function) between ads, speech and music.
  * `softmax`: same as softmaxraw, but smoothed in time with `slotsFuture` data points in the future and `slotsPast` data points in the past. Smoothing weights are defined by `consts.MOV_AVG_WEIGHTS` in [`post-processing.js`](https://github.com/dest4/adblockradio/blob/master/post-processing.js).

- `hotlist`: null if not available, otherwise an object containing the results of the fingerprint matcher.
  * `class`: either `0-ads`, `1-speech`, `2-music`, `3-jingles` or `unsure`
  * `file`: if class is not "unsure", the reference of the file recognized.
  * `total`: number of fingerprints computed for the given audio segment.
  * `matches`: number of matching fingerprints between the audio segment and the fingerprint database.

- `class`: final prediction of the algorithm. Either `0-ads`, `1-speech`, `2-music`, `3-jingles` or `unsure`.

- `metadata`: live metadata, fetched and parsed by the module [dest4/webradio-metadata](https://github.com/dest4/webradio-metadata).

- `streamInfo`: static metadata about the stream. Contains stream `url`, `favicon`, audio files extension `audioExt` (`mp3` or `aac`) and `homepage` URL.

- `gain`: a [dB](https://en.wikipedia.org/wiki/Decibel) value representing the average volume of the stream. Useful if you wish to normalize the playback volume. Calculated by [`mlpredict.py`](https://github.com/dest4/adblockradio/blob/master/predictor-ml/mlpredict.py).

- `tBuffer`: seconds of audio buffer. Calculated by [dest4/stream-tireless-baler](https://github.com/dest4/stream-tireless-baler).
  
- `predictorStartTime`: timestamp of the algorithm startup. Useful to get the uptime.

- `playTime`: approximate timestamp of when the given audio is to be played. TODO check this.  
  
  
## License

AGPL-3.0 (see LICENSE file)

Your contribution to this project is welcome, but might be subject to a contributor's agreement.

If you wish to use this software with another license, do not hesitate to contact the author at a_npm (at) storelli (point) fr
