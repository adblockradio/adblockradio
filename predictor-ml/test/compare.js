const fs = require('fs');
const assert = require('assert');

const py = JSON.parse(fs.readFileSync('py.json'));
const js = JSON.parse(fs.readFileSync('js.json'));

//console.log(Object.keys(py));
//console.log(Object.keys(js));

// check data format
assert.equal(py.firstSample, js.firstSample);
assert.equal(py.samples, js.samples);

// test pre-emphasis calculations
for (let i=0; i<py.preemph.length; i++) {
	const relativeError = Math.abs(py.preemph[i] - js.preemph[i]) / js.preemph[i];
	assert(!isNaN(relativeError) && relativeError <= 1e-6,
		'Preemphasis calculation failed. i=' + i + ' py=>' + py.preemph[i] + ' js=>' + js.preemph[i]);
}

// test signal division into frames
assert(py.nwin === js.nWin, "Not the same amount of windows. py=" + py.nwin + " js=" + js.nWin);

for (let i=0; i<py.frames.length; i++) {
	assert(py.frames[i].length === js.frames[i].length,
		'Not the same length of signal frames. i=' + i + ' py=>' + py.frames[i].length + ' js=>' + js.frames[i].length);

	for (let j=0; j<py.frames[i].length; j++) {
		const relativeError = Math.abs(py.frames[i][j] - js.frames[i][j]) / js.frames[i][j];
		assert(!isNaN(relativeError) && relativeError <= 1e-6,
			'Signal framing failed. i=' + i + ' j=' + j + ' relativeErr=' + relativeError);
	}
}

// test first power spectrum
assert(py.powspec && js.powspec, "Missing power spectrum. Present in py=" + !!py.powspec + " js=" + !!js.powspec);
assert(py.powspec.length === js.powspec.length, "Mismatching power spectrum length. py=" + py.powspec.length + " js=" + js.powspec.length);
for (let i=0; i<js.powspec.length; i++) {
	const relativeError = Math.abs(py.powspec[i] - js.powspec[i]) / js.powspec[i];
	assert(!isNaN(relativeError) && relativeError <= (i === js.powspec.length - 1 ? 1e-2 : 1e-6),
		"Mismatching power spectrum at index " + i + " py=" + py.powspec[i] + " js=" + js.powspec[i]);
}

// what is the contribution of the Nyquist term in python's implementation that we approximate in JS implementation?
const ratio = js.powspec[js.powspec.length - 1] / js.powspec.reduce((acc, val) => acc + val);
//console.log("nyquist ratio: " + ratio);
assert(ratio <= 1e-3, "Power spectrum: approximation related to the Nyquist term does not hold. contribution=" + ratio);

// energy in each frame
assert(py.energy && js.energy, "Missing energy. Present in py=" + !!py.energy + " js=" + !!js.energy);
assert(py.energy.length && js.energy.length, "Mismatching energy array length. py=" + py.energy.length + " js=" + js.energy.length);
for (let i=0; i<py.energy.length; i++) {
	const relativeError = Math.abs(py.energy[i] - js.energy[i]) / js.energy[i];
	assert(!isNaN(relativeError) && relativeError <= 1e-5,
		"Mismatching energy in frame " + i + " py=" + py.energy[i] + " js=" + js.energy[i]);
}

// test filter bank
assert(py.filters && js.filters.filters, "Missing filters. Present in py=" + !!py.filters + " js=" + !!js.filters.filters);
assert.equal(py.filters.length, js.filters.filters.length, "Not the same amount of filters. py=" + py.filters.length + " js=" + js.filters.length);

assert(py.bins && js.filters.bins, "Missing filterbank bins. Present in py=" + !!py.bins + " js=" + !!js.filters.bins);
assert.deepEqual(py.bins, js.filters.bins, "Mismatch in the filterbank bins");

for (let i=0; i<py.filters.length; i++) {
	//assert.equal(py.filters[i].length, js.filters.filters[i].length, "Filter " + i + " has mismatching windows. py=" + py.filters[i].length + " js=" + js.filters.filters[i].length);
	//console.log(py.filters[i]);
	//console.log(js.filters.filters[i]);
	for (let j=0; j<Math.min(py.filters[i].length, js.filters.filters[i].length); j++) {
		const relativeError = (py.filters[i][j] === 0 && js.filters.filters[i][j] === 0) ? 0 :
			Math.abs(py.filters[i][j] - js.filters.filters[i][j]) / js.filters.filters[i][j];

		assert(!isNaN(relativeError) && relativeError <= 1e-6,
			"Mismatch between filters. filter " + i + " item " + j + " py=" + py.filters[i][j] + " js=" + js.filters.filters[i][j]);
	}
}

// mel features of each frame
assert(py.feat && js.feat, "Missing frame features");
assert.equal(py.feat.length, js.feat.length, "Frame features have different lengths");

for (let i=0; i<py.feat.length; i++) {
	assert.equal(py.feat[i].length, js.feat[i].length,
		"Amount of frame features mismatch. Frame " + i + " py=" + py.feat[i].length + " js=" + js.feat[i].length);

	for (let j=0; j<py.feat[i].length; j++) {
		const relativeError = Math.abs(py.feat[i][j] - js.feat[i][j]) / js.feat[i][j];
		assert(!isNaN(relativeError) && relativeError <= 1e-6, "Mismatch in feature " + j + " in frame " + i +
			" py=" + py.feat[i][j] + " js=" + js.feat[i][j]);
	}
}

// DCT
assert(py.dct && js.dct, "Missing DCT");
assert(py.dct.length && js.dct.length, "Different amount of DCT frames");

for (let i=0; i<py.dct.length; i++) {
	assert.equal(py.dct[i].length, js.dct[i].length,
		"Amount of DCT data mismatch. Frame " + i + " py=" + py.dct[i].length + " js=" + js.dct[i].length);

	for (let j=0; j<py.dct[i].length; j++) {
		const relativeError = Math.abs(py.dct[i][j] - js.dct[i][j]) / js.dct[i][j];
		assert(!isNaN(relativeError) && relativeError <= 1e-6, "Mismatch in dct coef " + j + " in frame " + i +
			" py=" + py.dct[i][j] + " js=" + js.dct[i][j]);
	}
}

// cepstral coefficients
assert(py.ceps && js.ceps, "Missing cepstral coefficients. Present in py=" + !!py.ceps + " js=" + !!js.ceps);
assert.equal(py.ceps.length, js.ceps.length, "Mismatching amount of frames between cepstral arrays. py=" + py.ceps.length + " js=" + js.ceps.length);

for (let i=0; i<py.ceps.length; i++) {
	assert.equal(py.ceps[i].length, js.ceps[i].length,
		"Amount of cepstral coefficients mismatch. py=" + py.ceps[i].length + " js=" + js.ceps[i].length);

		for (let j=0; j<py.ceps[i].length; j++) {
		const relativeError = Math.abs(py.ceps[i][j] - js.ceps[i][j]) / js.ceps[i][j];
		assert(!isNaN(relativeError) && relativeError <= 1e-6, "Mismatch in cepstral coefficient " + j + " in frame " + i +
			" py=" + py.ceps[i][j] + " js=" + js.ceps[i][j]);
		console.log("Ceps: match at frame " + i + " coef " + j + " val=" + py.ceps[i][j]);
	}
}
//assert.deepEqual(py.ceps, js.ceps);

/*'energy',
  'feat''*/
console.log('All tests are successful :)');