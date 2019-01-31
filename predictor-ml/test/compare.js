const fs = require('fs');

const py = JSON.parse(fs.readFileSync('py.json'));
const js = JSON.parse(fs.readFileSync('js.json'));

// test pre-emphasis calculations
for (let i=0; i<py.preemph.length; i++) {
	const relativeError = Math.abs(py.preemph[i] - js.preemph[i]) / js.preemph[i];
	if (isNaN(relativeError) || relativeError > 1e-6) {
		throw new Error('Preemphasis calculation failed. i=' + i + ' py=>' + py.preemph[i] + ' js=>' + js.preemph[i]);
	}
}

// test signal division into frames
for (let i=0; i<py.frames.length; i++) {
	if (py.frames[i].length !== js.frames[i].length) {
		throw new Error('Not the same length of signal frames. i=' + i + ' py=>' + py.frames[i].length + ' js=>' + js.frames[i].length);
	}
	for (let j=0; j<py.frames[i].length; j++) {
		const relativeError = Math.abs(py.frames[i][j] - js.frames[i][j]) / js.frames[i][j];
		if (isNaN(relativeError) || relativeError > 1e-6) {
			throw new Error('Signal framing failed. i=' + i + ' j=' + j + ' relativeErr=' + relativeError);
		}
	}
}

console.log('All tests are successful :)');