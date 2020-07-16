'use strict';

// Assuming normal speech speed. Looked here https://en.wikipedia.org/wiki/Sampling_(signal_processing)#Sampling_rate
const MIN_HUMAN_SPEECH_ADEQUATE_SAMPLE_RATE = 8000;
const MAX_MARGIN_BEFORE_VIDEO_TIME = 0.5;
// Not just MIN_SOUNDED_SPEED, because in theory sounded speed could be greater than silence speed.
const MIN_SPEED = 0.25;
const MAX_MARGIN_BEFORE_REAL_TIME = MAX_MARGIN_BEFORE_VIDEO_TIME / MIN_SPEED;

const numberSettingsNames = ['silenceSpeed', 'soundedSpeed', 'marginBefore', 'marginAfter'];

const logging = process.env.NODE_ENV !== 'production';

function getRealtimeMargin(marginBefore, speed) {
  return marginBefore / speed;
}

function getNewLookaheadDelay(videoTimeMargin, soundedSpeed, silenceSpeed) {
  return videoTimeMargin / Math.min(soundedSpeed, silenceSpeed)
}
function getTotalDelay(lookaheadNodeDelay, stretcherNodeDelay) {
  return lookaheadNodeDelay + stretcherNodeDelay;
}
function getNewSnippetDuration(originalRealtimeDuration, originalSpeed, newSpeed) {
  const videoSpeedSnippetDuration = originalRealtimeDuration * originalSpeed;
  return videoSpeedSnippetDuration / newSpeed;
}
// The delay that the stretcher node is going to have when it's done slowing down a snippet
function getStretcherDelayChange(snippetOriginalRealtimeDuration, originalSpeed, newSpeed) {
  const snippetNewDuration = getNewSnippetDuration(snippetOriginalRealtimeDuration, originalSpeed, newSpeed);
  const delayChange = snippetNewDuration - snippetOriginalRealtimeDuration;
  return delayChange;
}
// TODO Is it always constant though? What about these short silence snippets, where we don't have to fully reset the margin?
function getStretcherSoundedDelay(videoTimeMarginBefore, soundedSpeed, silenceSpeed) {
  const realTimeMarginBefore = videoTimeMarginBefore / silenceSpeed;
  const delayChange = getStretcherDelayChange(realTimeMarginBefore, silenceSpeed, soundedSpeed);
  return 0 + delayChange;
}

/**
 * The holy grail of this algorithm.
 * Answers the question "When is the sample that has been on the input at `momentTime` going to appear on the output?"
 * Contract:
 * * Only works for input values such that the correct answer is after the `lastScheduledStretcherDelayReset`'s start time.
 * * Assumes the video is never played backwards (i.e. stretcher delay never so quickly).
 */
function getMomentOutputTime(momentTime, lookaheadDelay, lastScheduledStretcherDelayReset) {
  const stretch = lastScheduledStretcherDelayReset;
  const stretchEndTotalDelay = getTotalDelay(lookaheadDelay, stretch.endValue);
  // Simpliest case. The target moment is after the `stretch`'s end time
  // TODO DRY `const asdadsd = momentTime + stretchEndTotalDelay;`?
  if (momentTime + stretchEndTotalDelay >= stretch.endTime) {
    return momentTime + stretchEndTotalDelay;
  } else {
    // `lastScheduledStretcherDelayReset` is going to be in progress when the target moment is on the output.

    // At which point between its start and end would the target moment be played if we were to not actually change the
    // delay ?
    const originalTargetMomentOffsetRelativeToStretchStart =
      momentTime + getTotalDelay(lookaheadDelay, stretch.startValue) - stretch.startTime;
    // By how much the snippet is going to be stretched?
    const playbackSpeedupDuringStretch =
      ((stretch.endTime - stretch.startTime) + (stretch.startValue - stretch.endValue))
      / (stretch.endTime - stretch.startTime);
    // How much time will pass since the stretch start until the target moment is played on the output?
    const finalTargetMomentOffsetRelativeToStretchStart =
      originalTargetMomentOffsetRelativeToStretchStart / playbackSpeedupDuringStretch;
    return stretch.startTime + finalTargetMomentOffsetRelativeToStretchStart;
  }
}

chrome.storage.sync.get(
  // TODO DRY with `popup.js`.
  {
    volumeThreshold: 0.010,
    silenceSpeed: 4,
    soundedSpeed: 1.75,
    enabled: true,
    marginBefore: 0.100,
    marginAfter: 0.100,
  },
  function (settings) {
    if (!settings.enabled) {
      return;
    }

    const currValues = {};
    numberSettingsNames.forEach(n => currValues[n] = settings[n]);

    async function controlSpeed(video) {
      video.playbackRate = currValues.soundedSpeed;

      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule(chrome.runtime.getURL('SilenceDetectorProcessor.js'));
      await ctx.audioWorklet.addModule(chrome.runtime.getURL('VolumeFilter.js'));

      const maxSpeedToPreserveSpeech = ctx.sampleRate / MIN_HUMAN_SPEECH_ADEQUATE_SAMPLE_RATE;
      const maxMaginStretcherDelay = MAX_MARGIN_BEFORE_REAL_TIME * (maxSpeedToPreserveSpeech / MIN_SPEED);

      const volumeFilter = new AudioWorkletNode(ctx, 'VolumeFilter', {
        processorOptions: {
          maxSmoothingWindowLength: 0.0001,
        },
        parameterData: {
          smoothingWindowLength: 0.0001, // TODO make a setting out of it.
        },
      });
      const silenceDetectorNode = new AudioWorkletNode(ctx, 'SilenceDetectorProcessor', {
        parameterData: {
          volumeThreshold: settings.volumeThreshold,
          durationThreshold: getRealtimeMargin(currValues.marginBefore, currValues.soundedSpeed),
        },
        processorOptions: { initialDuration: 0 },
        numberOfOutputs: 0,
      });
      const analyzerIn = ctx.createAnalyser();
      const analyzerOut = ctx.createAnalyser();
      const outVolumeFilter = new AudioWorkletNode(ctx, 'VolumeFilter');
      const lookahead = ctx.createDelay(MAX_MARGIN_BEFORE_REAL_TIME);
      lookahead.delayTime.value = getNewLookaheadDelay(currValues.marginBefore, currValues.soundedSpeed, currValues.silenceSpeed);
      const stretcher = ctx.createDelay(maxMaginStretcherDelay);
      stretcher.delayTime.value =
        getStretcherSoundedDelay(currValues.marginBefore, currValues.soundedSpeed, currValues.silenceSpeed);
      const src = ctx.createMediaElementSource(video);
      src.connect(lookahead);
      src.connect(volumeFilter);
      volumeFilter.connect(silenceDetectorNode);
      volumeFilter.connect(analyzerIn);
      lookahead.connect(stretcher);
      stretcher.connect(ctx.destination);
      stretcher.connect(outVolumeFilter);
      outVolumeFilter.connect(analyzerOut);

      let lastScheduledStretcherDelayReset = null;

      const logArr = [];
      const logBuffer = new Float32Array(analyzerOut.fftSize);
      function log(msg = null) {
        analyzerOut.getFloatTimeDomainData(logBuffer);
        const outVol = logBuffer[logBuffer.length - 1];
        analyzerIn.getFloatTimeDomainData(logBuffer);
        const inVol = logBuffer[logBuffer.length - 1];
        logArr.push({
          msg,
          t: ctx.currentTime,
          delay: stretcher.delayTime.value,
          speed: video.playbackRate,
          inVol,
          outVol,
        });
      }

      silenceDetectorNode.port.onmessage = (msg) => {
        const { time: eventTime, type: silenceStartOrEnd } = msg.data;
        if (silenceStartOrEnd === 'silenceEnd') {
          video.playbackRate = currValues.soundedSpeed;

          // TODO all this does look like it may cause a snowballing floating point error. Mathematically simplify this?
          // Or just use if-else?

          const lastSilenceSpeedLastsForRealtime = eventTime - lastScheduledStretcherDelayReset.newSpeedStartInputTime;
          const lastSilenceSpeedLastsForVideoTime = lastSilenceSpeedLastsForRealtime * currValues.silenceSpeed;

          const marginBeforePartAtSilenceSpeedVideoTimeDuration = Math.min(
            lastSilenceSpeedLastsForVideoTime,
            currValues.marginBefore
          );
          const marginBeforePartAlreadyAtSoundedSpeedVideoTimeDuration =
            currValues.marginBefore - marginBeforePartAtSilenceSpeedVideoTimeDuration;
          const marginBeforePartAtSilenceSpeedRealTimeDuration =
            marginBeforePartAtSilenceSpeedVideoTimeDuration / currValues.silenceSpeed;
          const marginBeforePartAlreadyAtSoundedSpeedRealTimeDuration =
            marginBeforePartAlreadyAtSoundedSpeedVideoTimeDuration / currValues.soundedSpeed;
          // The time at which the moment from which the speed of the video needs to be slow has been on the input.
          const marginBeforeStartInputTime =
            eventTime
            - marginBeforePartAtSilenceSpeedRealTimeDuration
            - marginBeforePartAlreadyAtSoundedSpeedRealTimeDuration;
          // Same, but when it's going to be on the output.
          const marginBeforeStartOutputTime = getMomentOutputTime(
            marginBeforeStartInputTime,
            lookahead.delayTime.value,
            lastScheduledStretcherDelayReset
          );
          const marginBeforeStartOutputTimeTotalDelay = marginBeforeStartOutputTime - marginBeforeStartInputTime;
          const marginBeforeStartOutputTimeStretcherDelay =
            marginBeforeStartOutputTimeTotalDelay - lookahead.delayTime.value;

          // As you remember, silence on the input must last for some time before we speed up the video.
          // We then speed up these sections by reducing the stretcher delay.
          // And sometimes we may stumble upon a silence period long enough to make us speed up the video, but short
          // enough for us to not be done with speeding up that last part, so the margin before and that last part
          // overlap, and we end up in a situation where we only need to stretch the last part of the margin before
          // snippet, because the first one is already at required (sounded) speed, due to that delay before we speed up
          // the video after some silence.
          // This is also the reason why `getMomentOutputTime` function is so long.
          // Let's find this breakpoint.

          if (marginBeforeStartOutputTime < lastScheduledStretcherDelayReset.endTime) {
            // Cancel the complete delay reset, and instead stop decreasing it at `marginBeforeStartOutputTime`.
            stretcher.delayTime
              .cancelAndHoldAtTime(marginBeforeStartOutputTime)
              .linearRampToValueAtTime(marginBeforeStartOutputTimeStretcherDelay, marginBeforeStartOutputTime);
              // Maybe it's more clear to write this as:
              // .cancelAndHoldAtTime(lastScheduledStretcherDelayReset.startTime)
              // .linearRampToValueAtTime(marginBeforeStartOutputTimeStretcherDelay, marginBeforeStartOutputTime)
            if (logging) {
              log({
                type: 'pauseReset',
                value: marginBeforeStartOutputTimeStretcherDelay,
                time: marginBeforeStartOutputTime,
              });
            }
          }

          const marginBeforePartAtSilenceSpeedStartOutputTime =
            marginBeforeStartOutputTime + marginBeforePartAlreadyAtSoundedSpeedRealTimeDuration
          // Need to `setValueAtTime` to the same value again so further `linearRampToValueAtTime` makes increasing the
          // delay from `marginBeforePartAtSilenceSpeedStartOutputTime`.
          stretcher.delayTime.setValueAtTime(
            marginBeforeStartOutputTimeStretcherDelay,
            marginBeforePartAtSilenceSpeedStartOutputTime
          );
          if (logging) {
            log({
              type: 'setValueAtTime',
              value: marginBeforeStartOutputTimeStretcherDelay,
              time: marginBeforePartAtSilenceSpeedStartOutputTime,
            });
          }
          // const silenceSpeedPartStretchedDuration = getNewSnippetDuration(
          //   marginBeforePartAtSilenceSpeedRealTimeDuration,
          //   currValues.silenceSpeed,
          //   currValues.soundedSpeed
          // );
          const stretcherDelayIncrease = getStretcherDelayChange(
            marginBeforePartAtSilenceSpeedRealTimeDuration,
            currValues.silenceSpeed,
            currValues.soundedSpeed
          );
          // I think currently it should always be equal to the max delay.
          const finalStretcherDelay = marginBeforeStartOutputTimeStretcherDelay + stretcherDelayIncrease;
          stretcher.delayTime.linearRampToValueAtTime(
            finalStretcherDelay,
            // A.k.a. `marginBeforePartAtSilenceSpeedStartOutputTime + silenceSpeedPartStretchedDuration`
            eventTime + getTotalDelay(lookahead.delayTime.value, finalStretcherDelay)
          );
          if (logging) {
            log({
              type: 'linearRampToValueAtTime',
              value: finalStretcherDelay,
              time: eventTime + getTotalDelay(lookahead.delayTime.value, finalStretcherDelay),
            });
          }
        } else {
          // (Almost) same calculations as obove.
          video.playbackRate = currValues.silenceSpeed;

          const oldRealtimeMargin = getRealtimeMargin(currValues.marginBefore, currValues.soundedSpeed);
          // When the time comes to increase the video speed, the stretcher's delay is always at its max value.
          const stretcherDelayStartValue =
            getStretcherSoundedDelay(currValues.marginBefore, currValues.soundedSpeed, currValues.silenceSpeed);
          const startIn = getTotalDelay(lookahead.delayTime.value, stretcherDelayStartValue) - oldRealtimeMargin;

          const speedUpBy = currValues.silenceSpeed / currValues.soundedSpeed;

          const originalRealtimeSpeed = 1;
          const delayDecreaseSpeed = speedUpBy - originalRealtimeSpeed;
          const snippetNewDuration = stretcherDelayStartValue / delayDecreaseSpeed;
          const startTime = eventTime + startIn;
          const endTime = startTime + snippetNewDuration;
          stretcher.delayTime
            .setValueAtTime(stretcherDelayStartValue, startTime)
            .linearRampToValueAtTime(0, endTime);
          lastScheduledStretcherDelayReset = {
            newSpeedStartInputTime: eventTime,
            startTime,
            startValue: stretcherDelayStartValue,
            endTime,
            endValue: 0,
          };

          if (logging) {
            log({
              type: 'reset',
              startValue: stretcherDelayStartValue,
              startTime: startTime,
              endTime: endTime,
              lastScheduledStretcherDelayReset,
            });
          }
        }
      }

      if (logging) {
        setInterval(() => {
          log();
        }, 1);
      }

      chrome.storage.onChanged.addListener(function (changes) {
        numberSettingsNames.forEach(n => {
          const change = changes[n];
          if (change !== undefined) {
            currValues[n] = change.newValue;
          }
        });

        const marginBeforeChange = changes.marginBefore;
        if (marginBeforeChange !== undefined) {
          // TODO gradual change?
          lookahead.delayTime.value = getNewLookaheadDelay(currValues.marginBefore, currValues.soundedSpeed, currValues.silenceSpeed);
        }

        const marginAfterChange = changes.marginAfter;
        // if (marginAfterChange !== undefined) {}

        if (marginBeforeChange !== undefined || marginAfterChange !== undefined) {
          const durationThresholdParam = silenceDetectorNode.parameters.get('durationThreshold');
          // TODO DRY with constructor.
          durationThresholdParam.value = currValues.marginBefore + currValues.marginAfter;
        }

        const volumeThresholdChange = changes.volumeThreshold;
        if (volumeThresholdChange !== undefined) {
          const volumeThresholdParam = silenceDetectorNode.parameters.get('volumeThreshold');
          volumeThresholdParam.setValueAtTime(volumeThresholdChange.newValue, ctx.currentTime);
        }
      });
    }

    const video = document.querySelector('video');
    if (video === null) {
      // TODO search again when document updates? Or just after some time?
      console.log('Jump cutter: no video found. Exiting');
      return;
    }
    controlSpeed(video);
  }
);