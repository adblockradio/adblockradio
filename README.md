# Adblock Radio

![Adblock Radio](https://www.adblockradio.com/assets/img/abr_buddha_v3_175.png)

A library to block ads on live radio streams and podcasts. Machine learning meets Shazam.

Engine of [AdblockRadio.com](https://www.adblockradio.com).
Demo standalone player [available here](https://github.com/adblockradio/buffer-player).

Build status:
[![CircleCI](https://circleci.com/gh/adblockradio/adblockradio.svg?style=svg)](https://circleci.com/gh/adblockradio/adblockradio)

Help the project grow:
<a href="https://liberapay.com/asto/donate"><img alt="Donate using Liberapay" src="https://liberapay.com/assets/widgets/donate.svg"></a>

## Overview
A technical discussion is available [here](https://www.adblockradio.com/blog/2018/11/15/designing-audio-ad-block-radio-podcast/).

Radio streams are downloaded in `predictor.js` with the module [adblockradio/stream-tireless-baler](https://github.com/adblockradio/stream-tireless-baler). Podcasts are downloaded in `predictor-file.js`.

In both cases, audio is then decoded to single-channel, `22050 Hz` PCM with `ffmpeg`.

Chunks of about one second of PCM audio are piped into two sub-modules:
- a time-frequency analyser (`predictor-ml/ml.js`), that analyses spectral content with a neural network.
- a fingerprint matcher (`predictor-db/hotlist.js`), that searches for exact occurrences of known ads, musics or jingles.

In `post-processing.js`, results are gathered for each audio segment and cleaned.

A Readable interface, `Analyser`, is exposed to the end user. It streams objects containing the audio itself and all analysis results.

On a regular laptop CPU and with the Python time-frequency analyser, computations run at 5-10X for files and at 10-20% usage for live stream.

## Getting started

### Installation

##### Mandatory prerequisites:
You need Node.js (>= v10.12.x, but < 11) and NPM. Download it [here](https://nodejs.org/en/download/). Pro-tip: to manage several node versions on your platform, use [NVM](https://github.com/creationix/nvm).

On Debian Stretch:
```bash
apt-get install -y git ssh tar gzip ca-certificates build-essential sqlite3 ffmpeg
```
Note: works on Jessie, but installing ffmpeg is a bit painful. See [here](https://ffmpeg.org/download.html) and [there](https://superuser.com/questions/286675/how-to-install-ffmpeg-on-debian).

##### Optional prerequisites:
For best performance (~2x speedup) you should choose to do part of the computations with Python. Additional prerequisites are the following: Python (tested with v2.7.9), [Keras](https://keras.io/#installation) (tested with v2.0.8) and [Tensorflow](https://www.tensorflow.org/install/) (tested with CPU v1.4.0 and GPU v1.3.0).

On Debian:
```bash
apt-get install python-dev portaudio19-dev
pip install python_speech_features h5py numpy scipy keras tensorflow zerorpc sounddevice psutil
```
Note: if you do not have pip [follow these instructions to install it](https://pip.pypa.io/en/stable/installing/).

##### Then install this module:
```bash
git clone https://github.com/adblockradio/adblockradio.git
cd adblockradio
npm install
```

### Testing

Validate your installation with the test suite:

```
npm test
```

### Command-line demo

At startup and periodically during runtime, filter configuration files are automatically updated from [adblockradio.com/models/](https://adblockradio.com/models/):
- a compatible machine-learning model (`model.keras` or `model.json` + `group1-shard1of1`), for the time-frequency analyser.
- a fingerprint database (`hotlist.sqlite`), for the fingerprint matcher.

#### Live stream analysis
Run the demo on French RTL live radio stream:
```bash
node demo.js
```

Here is a sample output of the demo script, showing an ad detected:
```
{
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
		"class": "9-unsure",
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

#### Podcast analysis
It is also possible to analyse radio recordings.
Run the demo on a recording of French RTL radio, including ads, talk and music:
```bash
node demo-file.js
```

Gradual outputs are similar to those of live stream analysis. An additional post-processing specific to recordings hides the uncertainties in predictions and shows big chunks for each class, with time stamps in milliseconds, making it ready for slicing.
```
[
	{
		"class": "1-speech",
		"tStart": 0,
		"tEnd": 58500
	},
	{
		"class": "0-ads",
		"tStart": 58500,
		"tEnd": 125500
	},
	{
		"class": "1-speech",
		"tStart": 125500,
		"tEnd": 218000
	},
	{
		"class": "2-music",
		"tStart": 218000,
		"tEnd": 250500
	},
	{
		"class": "1-speech",
		"tStart": 250500,
		"tEnd": 472949
	}
]
```
Note that when analyzing audio files, you still need to provide the name of a radio stream, because the algorithm has to load acoustic parameters and DB of known samples. Analysis of podcasts not tied to a radio is not yet supported, but may possibly be in the future.

## Documentation

### Usage

Below is a simple usage example. More thorough usage examples are available in the tests:
- file/podcast analysis: `test/file.js`
- live stream analysis: `test/online.js`
- record a live stream, analyse it later: `test/offline.js`

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
`file`|File to analyse (optional, analyse the live stream otherwise)|None

### Methods

Acoustic model and hotlist files are refreshed automatically on startup. If you plan to continuously run the algo for a long time, you can trigger manual updates. Note those methods are only available in live stream analysis mode.

Method|Parameters|Description
------|----------|-----------
`refreshPredictorMl`|None|Manually refresh the ML model (live stream only)
`refreshPredictorHotlist`|None|Manually refresh the hotlist DB (live stream only)
`refreshMetadata`|None|Manually refresh the [metadata scraper](https://github.com/adblockradio/webradio-metadata) (live stream only)
`stopDl`|None|Stop Adblock Radio (live stream only)


### Optional configuration
Properties marked with a `*` are meant to be used only with live radio stream analysis, not file analysis where they are ignored.

#### Scheduling

Property|Description|Default
--------|-----------|-------
`predInterval`|Send stream status to listener every N seconds|`1`
`saveDuration*`|If enabled, save audio file and metadata every N `predInterval` times|`10`
`modelUpdatesInterval`|If enabled, update model files every N minutes|`60`

#### Switches

Property|Description|Periodicity|Default
--------|-----------|-----------|-------
`enablePredictorMl`|Perform machine learning inference|`predInterval`|`true`
`JSPredictorMl`|Use tfjs instead of Python for ML inference (slower)|`false`
`enablePredictorHotlist`|Compute audio fingerprints and search them in a DB|`predInterval`|`true`
`saveAudio*`|Save stream audio data in segments on hard drive|`saveDuration`|`true`
`saveMetadata`|Save a JSON with predictions|`saveDuration`|`true`
`fetchMetadata*`|Gather metadata from radio websites|`saveDuration`|`true`
`modelUpdates`|Keep ML and hotlist files up to date|`modelUpdatesInterval`|`true`

#### Paths

Property|Description|Default
--------|-----------|-------
`modelPath`|Directory where ML models and hotlist DBs are stored|`process.cwd() + '/model'`
`modelFile`|Path of ML file relative to `modelPath`|`country + '_' + name + '/model.keras'`
`hotlistFile`|Path of the hotlist DB relative to `modelPath`|`country + '_' + name + '/hotlist.sqlite'`
`saveAudioPath*`|Root folder where audio and metadata are saved|`process.cwd() + '/records'`

### Output

Readable streams constructed with `Analyser` emit objects with the following properties. Some properties are only available when doing live radio analysis. They are marked with a `*`. Other specific to file analysis are marked with `**`.

- `audio*`: Buffer containing a chunk of original (compressed) audio data.

- `ml`: `null` if not available, otherwise an object containing the results of the time-frequency analyser
  * `softmaxraw`: an array of three numbers representing the [softmax](https://en.wikipedia.org/wiki/Softmax_function) between ads, speech and music.
  * `softmax`: same as softmaxraw, but smoothed in time with `slotsFuture` data points in the future and `slotsPast` data points in the past. Smoothing weights are defined by `consts.MOV_AVG_WEIGHTS` in [`post-processing.js`](https://github.com/adblockradio/adblockradio/blob/master/post-processing.js).
  * `class`: either `0-ads`, `1-speech`, `2-music` or `9-unsure`. The classification according to `softmax`.

- `hotlist`: null if not available, otherwise an object containing the results of the fingerprint matcher.
  * `file`: if class is not "9-unsure", the reference of the file recognized.
  * `total`: number of fingerprints computed for the given audio segment.
  * `matches`: number of matching fingerprints between the audio segment and the fingerprint database.
  * `class`: either `0-ads`, `1-speech`, `2-music`, `3-jingles` or `9-unsure` if not enough matches have been found.

- `class`: final prediction of the algorithm. Either `0-ads`, `1-speech`, `2-music`, `3-jingles` or `9-unsure`.

- `metadata*`: live metadata, fetched and parsed by the module [adblockradio/webradio-metadata](https://github.com/adblockradio/webradio-metadata).

- `streamInfo*`: static metadata about the stream. Contains stream `url`, `favicon`, `bitrate` in bytes / s, audio files extension `audioExt` (`mp3` or `aac`) and `homepage` URL.

- `gain`: a [dB](https://en.wikipedia.org/wiki/Decibel) value representing the average volume of the stream. Useful if you wish to normalize the playback volume. Calculated by [`mlpredict.py`](https://github.com/adblockradio/adblockradio/blob/master/predictor-ml/mlpredict.py).

- `tBuffer*`: seconds of audio buffer. Calculated by [adblockradio/stream-tireless-baler](https://github.com/adblockradio/stream-tireless-baler).

- `predictorStartTime*`: timestamp of the algorithm startup. Useful to get the uptime.

- `playTime*`: approximate timestamp of when the given audio is to be played. TODO check this.

- `tStart**`: lower boundary of the time interval linked with the prediction (in milliseconds)

- `tEnd**`: upper boundary of the time interval linked with the prediction (in milliseconds)

## Supported radios
The list of supported radios is [available here](https://github.com/adblockradio/available-models).

### Note to developers
Integrations of this module are welcome. Suggestions are available [here](https://www.adblockradio.com/blog/2018/11/15/designing-audio-ad-block-radio-podcast/#product-design).

A standalone demo player for web browsers is [available here](https://github.com/adblockradio/buffer-player).

## License
See LICENSE file.

Your contribution to this project is welcome, but might be subject to a contributor's license agreement.
