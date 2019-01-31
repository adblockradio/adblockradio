const SAMPLING_RATE = 22050;
const MFCC_WINLEN = 0.05; // compute each MFCC frame with a window of that length (in seconds)
const MFCC_WINSTEP = 0.02; // how many seconds to step between each MFCC frame

const mfcc = require('../mfcc.js')(SAMPLING_RATE, MFCC_WINLEN, MFCC_WINSTEP, true);
const fs = require('fs');

const buf = fs.readFileSync('vousavezducourrier.pcm');

const results = mfcc(buf);

Object.assign(results, {
	samples: buf.length / 2,
	firstSample: buf.readInt16LE(0),
});

fs.writeFileSync('js.json', JSON.stringify(results));