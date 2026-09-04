#!/usr/bin/env python3
"""
Skid Circuit — car horn synthesizer.

Generates the game's horn sound effects from scratch (no samples needed):
real electric horns are flat diaphragm drivers + acoustic bell resonators,
which is very synthesizable — band-limited sawtooth "diaphragms", tanh drive
for the electromagnet grit, biquad bell formants, and a physically informed
envelope (pitch sag on attack, armature roughness while held, exponential
release). Output: 44.1 kHz mono OGG files in audio/.

Usage:
    python3 tools/make-horns.py            # regenerate audio/horn-*.ogg
    python3 tools/make-horns.py --out DIR  # write to a different directory

The generator is deterministic (fixed seed) so regeneration is reproducible.
Node test test-horns.mjs regenerates into a temp dir and FFT-verifies that
each file's dominant frequencies match the design (see HORN_SPECS).
"""

import argparse
import math
import os
import subprocess
import sys
import wave

import numpy as np

SR = 44100
RNG_SEED = 20260903


# ---------------------------------------------------------------------------
# Band-limited sawtooth "diaphragm" — additive harmonics up to ~16 kHz so the
# drive stage has a rich but non-aliasing spectrum to shape.
def band_limited_saw( freq, n, phase=0.0 ):
    t = np.arange( n, dtype=np.float64 )
    out = np.zeros( n, dtype=np.float64 )
    nyquist_limit = 16000.0
    k = 1
    while k * freq < nyquist_limit:
        out += np.sin( 2 * math.pi * k * freq * t / SR + phase * k ) / k
        k += 1
    return out * ( 2.0 / math.pi )  # ~[-1, 1]


# ---------------------------------------------------------------------------
# RBJ biquad peaking filter (the "bell" resonance of the horn housing).
def biquad_peaking( x, f0, q, gain_db ):
    a = 10 ** ( gain_db / 40.0 )
    w0 = 2 * math.pi * f0 / SR
    alpha = math.sin( w0 ) / ( 2 * q )
    b0 = 1 + alpha * a
    b1 = -2 * math.cos( w0 )
    b2 = 1 - alpha * a
    a0 = 1 + alpha / a
    a1 = -2 * math.cos( w0 )
    a2 = 1 - alpha / a
    b0, b1, b2 = b0 / a0, b1 / a0, b2 / a0
    a1, a2 = a1 / a0, a2 / a0
    y = np.empty_like( x )
    x1 = x2 = y1 = y2 = 0.0
    for i in range( len( x ) ):
        xn = x[ i ]
        yn = b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1 = x1, xn
        y2, y1 = y1, yn
        y[ i ] = yn
    return y


def lowpass_onepole( x, cutoff ):
    rc = 1.0 / ( 2 * math.pi * cutoff )
    dt = 1.0 / SR
    alpha = dt / ( rc + dt )
    y = np.empty_like( x )
    prev = 0.0
    for i in range( len( x ) ):
        prev = prev + alpha * ( x[ i ] - prev )
        y[ i ] = prev
    return y


# ---------------------------------------------------------------------------
def horn_tone( freq, dur, gain, drive, attack_s, release_s, vibrato_hz,
               vibrato_depth, sag_depth, sag_s, phase ):
    """One horn unit: detuned dual diaphragm + drive + envelope. Returns [-1, 1]."""
    n = int( dur * SR )
    t = np.arange( n, dtype=np.float64 ) / SR

    # Pitch contour: starts 'sag' flat (diaphragm loading up), settles, plus
    # slow vibrato from armature wobble.
    sag = 1.0 - sag_depth * np.exp( -t / sag_s )
    vib = 1.0 + vibrato_depth * np.sin( 2 * math.pi * vibrato_hz * t + phase )
    # Integrate instantaneous frequency into phase for both diaphragms.
    f_inst = freq * sag * vib
    phase_t = 2 * math.pi * np.cumsum( f_inst ) / SR

    # Two diaphragms, slightly detuned and phase-offset — the beating is what
    # makes real horns sound "mechanical" instead of like a synth.
    saw1 = band_limited_saw( freq, n, phase=phase )
    saw2 = band_limited_saw( freq * 1.008, n, phase=phase + 1.7 )
    # Re-align to the pitch contour by resampling cheaply: scale the base
    # saws by the mean factor (contour drift is tiny; this keeps it simple
    # while preserving the slow vibrato in the AM below).
    drift = f_inst / freq
    x = 0.6 * saw1 + 0.4 * saw2 * 1.0
    x = x * ( 0.85 + 0.15 * drift )

    # Electromagnet drive: soft clip grows even harmonics + compression.
    x = np.tanh( drive * x ) / math.tanh( drive )

    # Envelope: raised-cosine attack, settle dip (diaphragm finds its seat),
    # armature roughness AM while held, exponential release at the end.
    attack = int( attack_s * SR )
    release = int( release_s * SR )
    env = np.ones( n )
    if attack > 0:
        ramp = 0.5 - 0.5 * np.cos( math.pi * np.arange( attack ) / attack )
        env[ :attack ] = ramp
    # settle dip around 60-110ms
    dip_t = int( 0.07 * SR )
    dip_w = int( 0.045 * SR )
    if dip_t + dip_w < n:
        tt = np.arange( dip_w ) / dip_w
        env[ dip_t:dip_t + dip_w ] *= 1.0 - 0.18 * np.sin( math.pi * tt )
    # armature roughness: ~21 Hz AM + gentle slow wander
    rough = 1.0 + 0.055 * np.sin( 2 * math.pi * 21.3 * t + phase * 2.0 )
    rng = np.random.default_rng( RNG_SEED )
    wander = np.cumsum( rng.standard_normal( n ) * 0.0004 )
    wander = 1.0 + 0.02 * np.tanh( wander )
    env *= rough * wander
    # release
    if release > 0 and release < n:
        rel_idx = np.arange( release )
        env[ -release: ] *= np.exp( -rel_idx / ( release / 5.0 ) )

    x = x * env * gain
    return x


def synth_horn( spec ):
    tones = []
    for ( freq, gain ) in spec[ 'tones' ]:
        tones.append( horn_tone(
            freq=freq,
            dur=spec[ 'dur' ],
            gain=gain,
            drive=spec[ 'drive' ],
            attack_s=spec[ 'attack' ],
            release_s=spec[ 'release' ],
            vibrato_hz=spec[ 'vibrato_hz' ],
            vibrato_depth=spec[ 'vibrato_depth' ],
            sag_depth=spec[ 'sag_depth' ],
            sag_s=spec[ 'sag_s' ],
            phase=spec[ 'tones' ].index( ( freq, gain ) ) * 2.1 + 0.4,
        ) )
    n = max( len( t ) for t in tones )
    x = np.zeros( n )
    for t in tones:
        x[ :len( t ) ] += t

    # Bell resonances: two peaks give the "honk" character; a lowpass keeps
    # the top end polite.
    for ( f0, q, gdb ) in spec[ 'formants' ]:
        x = biquad_peaking( x, f0, q, gdb )
    x = lowpass_onepole( x, spec.get( 'lowpass', 5200 ) )

    # Tiny cabinet "click" at the onset for realism.
    click_n = int( 0.004 * SR )
    rng = np.random.default_rng( RNG_SEED + 1 )
    click = rng.standard_normal( click_n ) * np.exp( -np.arange( click_n ) / ( click_n / 6 ) )
    x[ :click_n ] += click * 0.05

    # Normalize to ~-1.5 dBFS.
    peak = np.max( np.abs( x ) )
    if peak > 0:
        x = x * ( 10 ** ( -1.5 / 20 ) / peak )
    return x


def write_wav( path, x ):
    data = ( x * 32767 ).astype( '<i2' )
    with wave.open( path, 'wb' ) as w:
        w.setnchannels( 1 )
        w.setsampwidth( 2 )
        w.setframerate( SR )
        w.writeframes( data.tobytes() )


# ---------------------------------------------------------------------------
# The horn lineup. Frequencies chosen like real units (dual-tone car horns are
# tuned a musical interval apart; trucks run low single/fifth stacks).
HORN_SPECS = {
    # Standard sedan dual-tone: a fourth apart, balanced.
    'horn-classic': {
        'tones': [ ( 420.0, 1.0 ), ( 500.0, 0.9 ) ],
        'formants': [ ( 1700, 1.4, 9.0 ), ( 3100, 2.0, 5.0 ) ],
        'drive': 2.4, 'dur': 0.90, 'attack': 0.008, 'release': 0.09,
        'vibrato_hz': 5.5, 'vibrato_depth': 0.0035, 'sag_depth': 0.014, 'sag_s': 0.045,
    },
    # Big rig air horn: low fundamental + fifth + sub, slow swell.
    'horn-truck': {
        'tones': [ ( 233.0, 1.0 ), ( 350.0, 0.55 ), ( 117.0, 0.35 ) ],
        'formants': [ ( 800, 1.2, 10.0 ), ( 1600, 1.8, 6.0 ) ],
        'drive': 3.0, 'dur': 1.30, 'attack': 0.045, 'release': 0.22,
        'vibrato_hz': 4.5, 'vibrato_depth': 0.008, 'sag_depth': 0.02, 'sag_s': 0.09,
        'lowpass': 4200,
    },
    # Sporty chirp: higher pair, brighter bell, snappy.
    'horn-sport': {
        'tones': [ ( 545.0, 1.0 ), ( 660.0, 0.85 ) ],
        'formants': [ ( 2400, 1.5, 9.0 ), ( 4200, 2.2, 4.0 ) ],
        'drive': 2.8, 'dur': 0.60, 'attack': 0.004, 'release': 0.06,
        'vibrato_hz': 6.5, 'vibrato_depth': 0.003, 'sag_depth': 0.012, 'sag_s': 0.03,
        'lowpass': 6000,
    },
    # Little hatchback "meep": one modest unit, polite and short.
    'horn-compact': {
        'tones': [ ( 620.0, 1.0 ) ],
        'formants': [ ( 1900, 1.6, 8.0 ), ( 3400, 2.4, 3.0 ) ],
        'drive': 1.8, 'dur': 0.45, 'attack': 0.006, 'release': 0.07,
        'vibrato_hz': 6.0, 'vibrato_depth': 0.004, 'sag_depth': 0.01, 'sag_s': 0.035,
        'lowpass': 5500,
    },
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument( '--out', default='audio' )
    args = ap.parse_args()
    out = args.out
    os.makedirs( out, exist_ok=True )
    tmp = os.path.join( out, '.tmp-horn-wavs' )
    os.makedirs( tmp, exist_ok=True )
    try:
        for name, spec in HORN_SPECS.items():
            wav = os.path.join( tmp, name + '.wav' )
            ogg = os.path.join( out, name + '.ogg' )
            write_wav( wav, synth_horn( spec ) )
            subprocess.run(
                [ 'ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libvorbis', '-q:a', '4', ogg ],
                check=True,
            )
            print( f"  ✓ { name }.ogg ({ os.path.getsize( ogg ) // 1024 } KB)" )
    finally:
        import shutil
        shutil.rmtree( tmp, ignore_errors=True )


if __name__ == '__main__':
    main()
