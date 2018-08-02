# Adblock Radio
An adblocker for live radio streams and podcasts. Machine learning meets Shazam.

## Outline
This module determines if the content of live radio streams or podcasts is advertisement, talk or music. It is the engine of [Adblock Radio](https://www.adblockradio.com).

Radio streams are downloaded in `predictor.js` with the module [dest4/stream-tireless-baler](https://github.com/dest4/stream-tireless-baler). Podcasts are downloaded in `predictor-file.js`. In both cases, audio is then decoded to single-channel, `22050 Hz` PCM with `ffmpeg`.

The following computations are in two steps: 

### Analysis of audio on a short time-window
Chunks of ~1s of PCM audio is piped into two sub-modules:
- a time-frequency analyser (`predictor-ml/ml.js`), that identifies patterns in spectrograms with a machine learning [recurrent neural network](https://en.wikipedia.org/wiki/Recurrent_neural_network).
- a fingerprint matcher (`predictor-db/hotlist.js`), that searches for exact occurrences of known audio samples (using module [dest4/stream-audio-fingerprint](https://github.com/dest4/stream-audio-fingerprint)).

### Post-processing to smooth the results
In `post-processing.js`, results are gathered for each audio segment. Past results are taken into account, as well as future results, within the limits of the file boundaries or the stream audio buffer (usually between 4s and 16s). Predictions are smoothed and dubious data points are pruned.

A Readable interface, `Analyser`, is exposed to the end user. It streams objects containing the audio itself and all analysis results. On a regular laptop CPU, computations run at 5-10X for files and at 10-20% usage for live stream.

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

#### Podcast analysis
It is also possible to analyse radio recordings.
Run the demo on a recording of French RTL radio, including ads, talk and music:
```bash
node demo-file.js
```

The results show classifications with time boundaries in milliseconds.
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
Note that when analysing files, you still need to provide the name of a radio stream, because the algorithm has to load acoustic parameters and DB of known samples. Analysis of podcasts not tied to a radio is not yet supported, but will probably be in the future.

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
`file`|File to analyse (optional)|None

### Optional configuration

#### Stream segmentation

Property|Description|Default
--------|-----------|-------
`predInterval`|send stream status to listener every N seconds|`1`
`saveDuration`|save audio file and metadata every N `predInterval` times (streams only)|`10`

#### Switches

Property|Description|Periodicity|Default
--------|-----------|-----------|-------
`enablePredictorMl`|perform machine learning inference|`predInterval`|`true`
`enablePredictorHotlist`|compute audio fingerprints and search them in a DB|`predInterval`|`true`
`saveAudio`|save stream audio data in segments on hard drive (streams only)|`saveDuration`|`true`
`saveMetadata`|save a JSON with predictions|`saveDuration`|`true`
`fetchMetadata`|gather metadata from radio websites (streams only)|`saveDuration`|`true`

#### Paths

Property|Description|Default
--------|-----------|-------
`modelPath`|directory where ML models and hotlist DBs are stored|`__dirname + '/model'`
`saveAudioPath`|root folder where audio and metadata are saved (streams only)|`__dirname + '/records'`

### Output

Readable streams constructed with `Analyser` emit objects with the following properties.

- `audio`: Buffer containing a chunk of original (compressed) audio data (streams only).

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

- `metadata`: live metadata, fetched and parsed by the module [dest4/webradio-metadata](https://github.com/dest4/webradio-metadata) (streams only).

- `streamInfo`: static metadata about the stream. Contains stream `url`, `favicon`, audio files extension `audioExt` (`mp3` or `aac`) and `homepage` URL (streams only).

- `gain`: a [dB](https://en.wikipedia.org/wiki/Decibel) value representing the average volume of the stream. Useful if you wish to normalize the playback volume. Calculated by [`mlpredict.py`](https://github.com/dest4/adblockradio/blob/master/predictor-ml/mlpredict.py).

- `tBuffer`: seconds of audio buffer. Calculated by [dest4/stream-tireless-baler](https://github.com/dest4/stream-tireless-baler) (streams only).
  
- `predictorStartTime`: timestamp of the algorithm startup. Useful to get the uptime (streams only).

- `playTime`: approximate timestamp of when the given audio is to be played (streams only). TODO check this.  
  

## Supported radios

### Belgium
- Bel-RTL
- MNM
- Radio 1
- RTBF La Première
- Studio Brussel
- Zen FM

### France
- Alouette
- BFM Business
- Chante France
- Chérie
- Djam Radio
- Europe 1
- FIP
- France Culture
- France Info
- France Inter
- France Musique
- Fun Radio
- Jazz Radio
- M Radio
- Nostalgie
- Nova Lyon - RTU
- NRJ
- OÜI FM
- Radio Classique
- Radio FG
- Radio Meuh
- Radio Nova
- Radio Scoop Lyon
- RFM
- Rire et Chansons
- RMC
- RTL
- RTL2
- Skyrock
- TSF Jazz
- Virgin Radio France
- Voltage

### Germany
- bigFM Deutschland
- Fritz
- Jam FM
- Klassik Radio
- Radio 7
- RTL Radio
- TechnoBase.FM

### Italy
- Radio 24
- Radio 80
- Radio Capital
- Radio Company
- Rai Radio 1
- Rai Radio 2
- Rai Radio 3

### Spain
- Cadena 100
- Cadena SER
- RAC1
- Rock FM

### Switzerland
- RTS Couleur 3
- RTS La Premiere
- Spoon Radio

### United Kingdom
- Absolute Radio
- BBC Radio 1
- BBC Radio 2
- BBC Radio 3
- Kane FM
- Kiss UK

## Future work

### Improvements
- Native advertisements are not well recognized. Plugging speech recognition software in and doing semantic analysis could help.
- Analog signals (FM) have not been tested and are not currently supported. Work on this topic could broaden the use cases of this project.
- Support for popular podcasts.

### Integrations
This project is not intended to be handled by end-users. Integrations of this project in mass market products are welcome:
- mobile apps for webradios and podcasts. Keras models should be converted to native Tensorflow ones, and the Keras + Tensorflow library could be replaced with [Tensorflow Mobile for Android and iOS](https://www.tensorflow.org/mobile/mobile_intro). Node.JS routines could be integrated with this [React Native plugin](https://www.npmjs.com/package/nodejs-mobile-react-native).
- browser extensions, with [Tensorflow JS](https://js.tensorflow.org/).
- digital alarm-clocks, and hobbyist projects, as long as enough computation power and network are available. Platforms as small as Raspberry Pi Zero/A/B should be enough, though RPi 3B/3B+ is recommended. Tensorflow is available on [Raspbian](https://www.tensorflow.org/install/install_raspbian).

## License
AGPL-3.0 (see LICENSE file)

Your contribution to this project is welcome, but might be subject to a contributor's agreement.

If you wish to use this software with another license, do not hesitate to contact the author at a_npm (at) storelli (point) fr
