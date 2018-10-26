'use strict';

const axios = require('axios');
const tar = require('tar');
const fs = require('fs-extra');
const { log } = require('abr-log')('checkModelUpdates');

const URL_PREFIX = 'https://www.adblockradio.com/models/';
const CHECKSUM_SUFFIX = '.sha256sum';

const isToUpdate = async function(path, file) {
	let localChecksum = null;
	try {
		localChecksum = await fs.readFile(path + '/' + file + CHECKSUM_SUFFIX);
	} catch (e) {
		log.info('checksum for ' + path + '/' + file + ' not found. read err=' + e);
		return true;
	}
	try {
		const remoteChecksum = await axios.get(URL_PREFIX + file + CHECKSUM_SUFFIX);
		if ('' + localChecksum !== '' + remoteChecksum.data) {
			//log.info('different checksums local=' + localChecksum + ' remote=' + remoteChecksum.data);
			return true;
		} else {
			log.info(file + ' is up to date');
			return false;
		}
	} catch (e) {
		log.warn('could not fetch checksum for ' + path + '/' + file + '. err=' + e);
		return false;
	}
}

const update = async function(path, file) {
	log.info('update ' + path + '/' + file);
	try {
		const checksumData = await axios.get(URL_PREFIX + file + CHECKSUM_SUFFIX);
		await fs.writeFile(path + '/' + file + CHECKSUM_SUFFIX, checksumData.data);
		const data = await axios.get(URL_PREFIX + file, { responseType: 'arraybuffer' });
		await fs.writeFile(path + '/' + file, data.data);
		await tar.x({ file: path + '/' + file, cwd: path, strict: true });
		await fs.unlink(path + '/' + file);
	} catch (e) {
		log.warn('could not update ' + path + '/' + file + '. err=' + e);
	}
}

const check = async function(country, name, modelsPath, mlUpdateCallback, hotlistUpdateCallback) {
	const canonical = country + '_' + name;
	const modelFile = canonical + '.keras.tar.gz';
	if (await isToUpdate(modelsPath, modelFile)) {
		await update(modelsPath, modelFile);
		if (mlUpdateCallback) mlUpdateCallback();
	}
	const hotlistFile = canonical + '.sqlite.tar.gz';
	if (await isToUpdate(modelsPath, hotlistFile)) {
		await update(modelsPath, hotlistFile);
		if (hotlistUpdateCallback) hotlistUpdateCallback();
	}
}

module.exports = check;