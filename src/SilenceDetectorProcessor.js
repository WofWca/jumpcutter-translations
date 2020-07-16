'use strict';

class SilenceDetectorProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    const initialDuration = options.processorOptions.initialDuration !== undefined
      ? options.processorOptions.initialDuration
      : 0;
    this._lastLoudSampleTime = currentTime - initialDuration;
    const thresholdSamples = sampleRate * options.parameterData.durationThreshold;
    this._lastTimePostedSilenceStart = this.isPastDurationThreshold(thresholdSamples);
  }
  static get parameterDescriptors() {
    return [
      {
        name: 'volumeThreshold',
        defaultValue: 0.10, // TODO DRY.
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate',
      },
      {
        // Don't do anything if silence lasts shorter than this.
        name: 'durationThreshold',
        minValue: 0,
        automationRate: 'k-rate',
      },
    ];
  }

  // Just so we don't mess up `>=` and `>` somewhere.
  isPastDurationThreshold(durationThreshold) {
    return currentTime >= this._lastLoudSampleTime + durationThreshold;
  }

  process(inputs, outputs, parameters) {
    const volumeThreshold = parameters.volumeThreshold[0];
    const input = inputs[0];
    const numSamples = input[0].length;
    for (let sampleI = 0; sampleI < numSamples; sampleI++) {
      let loudSampleFound = false;
      for (let channelI = 0; channelI < input.length; channelI++) {
        const sample = input[channelI][sampleI];
        if (sample >= volumeThreshold) {
          loudSampleFound = true;
          break;
        }
      }
      if (loudSampleFound) {
        this._lastLoudSampleTime = currentTime;
        if (this._lastTimePostedSilenceStart) {
          // console.log('lastStart:', this._lastTimePostedSilenceStart, this._lastLoudSampleTime, currentTime - this._lastLoudSampleTime);
          this.port.postMessage({ type: 'silenceEnd', time: currentTime });
          this._lastTimePostedSilenceStart = false;
        }
      } else {
        if (!this._lastTimePostedSilenceStart && this.isPastDurationThreshold(parameters.durationThreshold[0])) {
          // console.log('lastStart:', this._lastTimePostedSilenceStart, this._lastLoudSampleTime, currentTime - this._lastLoudSampleTime);
          this.port.postMessage({ type: 'silenceStart', time: currentTime });
          this._lastTimePostedSilenceStart = true;
        }
      }
    }
    return true;
  }
}

registerProcessor('SilenceDetectorProcessor', SilenceDetectorProcessor);