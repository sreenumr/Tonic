// Runs on the audio rendering thread: forwards raw mono PCM frames to the
// main thread, where app.js batches and streams them to the server.
class PCMCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      // Copy out of the reusable Web Audio buffer before posting.
      this.port.postMessage(channel.slice());
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PCMCaptureProcessor);
