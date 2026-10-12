"use strict";

// Self-contained function for page.evaluate; fail explicitly on integration errors.
async function readRxPackets() {
    if (typeof window.wsnVoiceCtl?.rxAudio !== "function") throw new Error("wsnVoiceCtl.rxAudio() is unavailable");
    const result = await window.wsnVoiceCtl.rxAudio();
    if (!Number.isFinite(result?.pkts) || result.pkts < 0) throw new Error("invalid inbound packet counter");
    return result.pkts;
}

class PacketGap {
    constructor(timeMs, packets, stallMs) {
        this.stallMs = stallMs;
        this.lastProgressMs = timeMs;
        this.stopMs = this.stopConfirmedMs = this.resumeMs = null;
        this.samples = [{ timeMs, packets, reset: false }];
    }
    observe(timeMs, packets, evidence = null) {
        const previous = this.samples.at(-1);
        if (!Number.isFinite(timeMs) || timeMs < previous.timeMs || !Number.isFinite(packets) || packets < 0) throw new Error("invalid packet observation");
        const reset = evidence ? evidence.resets > 0 : packets < previous.packets;
        // A removed/replaced peer resets the aggregate counter. Zero is not
        // packet progress; a new positive count is evidence of reception.
        const progress = evidence ? evidence.progress : packets > previous.packets || (reset && packets > 0);
        this.samples.push({ timeMs, packets, reset, evidence });
        if (progress) {
            this.lastProgressMs = timeMs;
            if (this.stopMs != null && this.resumeMs == null) this.resumeMs = timeMs;
        } else if (this.stopMs == null && timeMs - this.lastProgressMs >= this.stallMs) {
            // Confirmation waits stallMs; do not add that threshold to onset.
            this.stopMs = this.lastProgressMs;
            this.stopConfirmedMs = timeMs;
        }
    }
    summary(departMs, returnMs) {
        let invalidReason = null;
        if (this.stopMs == null) invalidReason = "no sustained packet stall observed";
        else if (this.resumeMs == null) invalidReason = "no packet recovery observed";
        else if (this.stopMs < departMs || this.stopMs >= returnMs || this.resumeMs < returnMs) invalidReason = "packet interruption does not span the return command";
        return {
            valid: invalidReason == null, invalidReason,
            departureCommandMs: departMs, returnCommandMs: returnMs,
            stopObservationMs: this.stopMs, stopConfirmedMs: this.stopConfirmedMs, resumeObservationMs: this.resumeMs,
            packetStopAfterOutMs: this.stopMs == null ? null : this.stopMs - departMs,
            packetRecoveryAfterReturnMs: this.resumeMs == null ? null : this.resumeMs - returnMs,
            packetInterruptionMs: this.stopMs == null || this.resumeMs == null ? null : this.resumeMs - this.stopMs,
            maxObservedPollIntervalMs: Math.max(0, ...this.samples.slice(1).map((sample, i) => sample.timeMs - this.samples[i].timeMs)),
            counterResets: this.samples.filter(sample => sample.reset).length,
        };
    }
}
module.exports = { readRxPackets, PacketGap };
