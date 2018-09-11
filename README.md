# Adblock Radio
An adblocker for live radio streams and podcasts. Machine learning meets Shazam.

Engine of [AdblockRadio.com](https://www.adblockradio.com).
![Adblock Radio](https://www.adblockradio.com/assets/img/abr_buddha_v3_175.png)

## Overview
A technical discussion is available [here](TODO).

Radio streams are downloaded in `predictor.js` with the module [dest4/stream-tireless-baler](https://github.com/dest4/stream-tireless-baler). Podcasts are downloaded in `predictor-file.js`.

In both cases, audio is then decoded to single-channel, `22050 Hz` PCM with `ffmpeg`.

Chunks of about one second of PCM audio are piped into two sub-modules:
- a time-frequency analyser (`predictor-ml/ml.js`), that analyses spectral content with a neural network.
- a fingerprint matcher (`predictor-db/hotlist.js`), that searches for exact occurrences of known ads, musics or jingles.

In `post-processing.js`, results are gathered for each audio segment and cleaned.

A Readable interface, `Analyser`, is exposed to the end user. It streams objects containing the audio itself and all analysis results.

On a regular laptop CPU, computations run at 5-10X for files and at 10-20% usage for live stream.

## Getting started

### Installation

As prerequisites, you need:
- Node.js and NPM. This project has been tested with node 8.* and 10.* (NPM 5.6.0 and 6.2.0 respectively). If you need to manage several node versions on your platform, you might want to use [NVM](https://github.com/creationix/nvm).
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
wget https://www.adblockradio.com/models/France_RTL.keras.tar.gz
tar -zxvf France_RTL.keras.tar.gz
rm France_RTL.keras.tar.gz
wget https://www.adblockradio.com/models/France_RTL.sqlite.tar.gz
tar -zxvf France_RTL.sqlite.tar.gz
rm France_RTL.sqlite.tar.gz
cd ..
```

Note that you can check for updates of those model files by first downloading checksum files (`*.tar.gz.sha256sum`) and comparing its contents with a local copy.

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
Note that when analyzing audio files, you still need to provide the name of a radio stream, because the algorithm has to load acoustic parameters and DB of known samples. Analysis of podcasts not tied to a radio is not yet supported, but will probably be in the future.

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
`file`|File to analyse (optional, analyse the live stream otherwise)|None

Keep in mind that you need to download models as shown in the demo section above.

### Optional configuration
Properties marked with a `*` are meant to be used only with live radio stream analysis, not file analysis where they are ignored.

#### Stream segmentation

Property|Description|Default
--------|-----------|-------
`predInterval`|send stream status to listener every N seconds|`1`
`saveDuration*`|save audio file and metadata every N `predInterval` times|`10`

#### Switches

Property|Description|Periodicity|Default
--------|-----------|-----------|-------
`enablePredictorMl`|perform machine learning inference|`predInterval`|`true`
`enablePredictorHotlist`|compute audio fingerprints and search them in a DB|`predInterval`|`true`
`saveAudio*`|save stream audio data in segments on hard drive|`saveDuration`|`true`
`saveMetadata`|save a JSON with predictions|`saveDuration`|`true`
`fetchMetadata*`|gather metadata from radio websites|`saveDuration`|`true`

#### Paths

Property|Description|Default
--------|-----------|-------
`modelPath`|directory where ML models and hotlist DBs are stored|`__dirname + '/model'`
`saveAudioPath*`|root folder where audio and metadata are saved|`__dirname + '/records'`

### Output

Readable streams constructed with `Analyser` emit objects with the following properties. Some properties are only available when doing live radio analysis. They are marked with a `*`. Other specific to file analysis are marked with `**`.

- `audio*`: Buffer containing a chunk of original (compressed) audio data.

- `ml`: `null` if not available, otherwise an object containing the results of the time-frequency analyser
  * `softmaxraw`: an array of three numbers representing the [softmax](https://en.wikipedia.org/wiki/Softmax_function) between ads, speech and music.
  * `softmax`: same as softmaxraw, but smoothed in time with `slotsFuture` data points in the future and `slotsPast` data points in the past. Smoothing weights are defined by `consts.MOV_AVG_WEIGHTS` in [`post-processing.js`](https://github.com/dest4/adblockradio/blob/master/post-processing.js).
  * `class`: either `0-ads`, `1-speech`, `2-music` or `unsure`. The classification according to `softmax`.

- `hotlist`: null if not available, otherwise an object containing the results of the fingerprint matcher.
  * `file`: if class is not "unsure", the reference of the file recognized.
  * `total`: number of fingerprints computed for the given audio segment.
  * `matches`: number of matching fingerprints between the audio segment and the fingerprint database.
  * `class`: either `0-ads`, `1-speech`, `2-music`, `3-jingles` or `unsure` if not enough matches have been found.

- `class`: final prediction of the algorithm. Either `0-ads`, `1-speech`, `2-music`, `3-jingles` or `unsure`.

- `metadata*`: live metadata, fetched and parsed by the module [dest4/webradio-metadata](https://github.com/dest4/webradio-metadata).

- `streamInfo*`: static metadata about the stream. Contains stream `url`, `favicon`, audio files extension `audioExt` (`mp3` or `aac`) and `homepage` URL.

- `gain`: a [dB](https://en.wikipedia.org/wiki/Decibel) value representing the average volume of the stream. Useful if you wish to normalize the playback volume. Calculated by [`mlpredict.py`](https://github.com/dest4/adblockradio/blob/master/predictor-ml/mlpredict.py).

- `tBuffer*`: seconds of audio buffer. Calculated by [dest4/stream-tireless-baler](https://github.com/dest4/stream-tireless-baler).

- `predictorStartTime*`: timestamp of the algorithm startup. Useful to get the uptime.

- `playTime*`: approximate timestamp of when the given audio is to be played. TODO check this.

- `tStart**`: lower boundary of the time interval linked with the prediction (in milliseconds)

- `tEnd**`: upper boundary of the time interval linked with the prediction (in milliseconds)

## Supported radios
The list of supported radios is [available here](https://github.com/dest4/available-models).

### Note to developers
Integrations of this module are welcome. Suggestions are available [here](TODO).

## License
See LICENSE file

Your contribution to this project is welcome, but might be subject to a contributor's license agreement.
