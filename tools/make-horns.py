#!/usr/bin/env python3
"""
Skid Circuit — car horn + emergency siren synthesizer.

Generates the game's horn and siren sound effects from scratch (no samples):
real electric horns are flat diaphragm drivers + acoustic bell resonators,
which is very synthesizable. Each horn now has its own *performance* —
the sedan does a friendly double "beep-beep", the truck groans low with a
growling tail, the sport horn is an excited rising chirp, the hatchback
does a polite double meep — plus three emergency sirens (police yelp,
ambulance hi-lo, fire-truck wail with air-horn blasts).

Physics modeled:
  - band-limited saw "diaphragms", two detuned per unit (mechanical beating)
  - tanh electromagnet drive (even-harmonic grit + compression)
  - RBJ biquad bell formants (the horn housing resonance)
  - pitch contours: attack sag, vibrato, deliberate glides (anti-monotone!)
  - armature roughness AM while held, exponential release
  - sirens: swept/alternating frequency contours, layered air-horn blasts

Output: 44.1 kHz mono OGG files in audio/.
Usage:
    python3 tools/make-horns.py            # regenerate audio/*.ogg
    python3 tools/make-horns.py --out DIR  # write elsewhere

Deterministic (fixed seed). Node test test-horns.mjs regenerates into a
temp dir and verifies spectral content (see SPECS / test table).
"""

import argparse
import math
import os
import shutil
import subprocess
import wave

import numpy as np

SR = 44100
RNG_SEED = 20260903
MAX_HARM = 44  # diaphragm harmonics before drive shaping


# ---------------------------------------------------------------------------
# Band-limited sawtooth with TIME-VARYING frequency (enables glides/sweeps).
def diaphragm( freq_t, phase0=0.0, max_harm=MAX_HARM ):
    ph = 2 * math.pi * np.cumsum( freq_t ) / SR + phase0
    out = np.zeros( len( freq_t ) )
    for k in range( 1, max_harm + 1 ):
        out += np.sin( k * ph ) / k
    return out * ( 2.0 / math.pi )


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
def make_env( n, attack_s, release_s, roughness=0.05, phase=0.0 ):
    """Raised-cosine attack, armature-roughness AM, exponential release."""
    t = np.arange( n, dtype=np.float64 ) / SR
    env = np.ones( n )
    attack = max( 1, int( attack_s * SR ) )
    if attack < n:
        env[ :attack ] = 0.5 - 0.5 * np.cos( math.pi * np.arange( attack ) / attack )
    rng = np.random.default_rng( RNG_SEED )
    wander = np.cumsum( rng.standard_normal( n ) * 0.0006 )
    env *= ( 1.0 + roughness * np.sin( 2 * math.pi * 21.3 * t + phase )
             + 0.02 * np.tanh( wander ) )
    release = int( release_s * SR )
    if 0 < release < n:
        env[ -release: ] *= np.exp( -np.arange( release ) / ( release / 5.0 ) )
    return env


def horn_burst( f0, dur, gain, drive, attack, release,
                glide=0.0, sag=0.015, sag_s=0.045, vib_hz=5.5, vib=0.004, phase=0.0 ):
    """One honk: dual detuned diaphragms + drive + envelope. Glide = pitch
    slide over the burst (fraction of f0 at the end). This is the knob that
    keeps horns from sounding monotone."""
    n = int( dur * SR )
    t = np.arange( n, dtype=np.float64 ) / SR
    freq_t = f0 * ( 1.0 - sag * np.exp( -t / sag_s ) ) \
               * ( 1.0 + glide * ( t / dur ) ) \
               * ( 1.0 + vib * np.sin( 2 * math.pi * vib_hz * t + phase ) )
    x = 0.6 * diaphragm( freq_t, phase ) + 0.4 * diaphragm( freq_t * 1.008, phase + 1.7, 28 )
    x = np.tanh( drive * x ) / math.tanh( drive )
    return x * make_env( n, attack, release, 0.05, phase ) * gain


def mix_into( buf, sig, t0 ):
    i0 = int( t0 * SR )
    i1 = min( len( buf ), i0 + len( sig ) )
    if i1 > i0:
        buf[ i0:i1 ] += sig[ :i1 - i0 ]


def finish( x, formants, lowpass=5200, click=0.05, peak_db=-1.5 ):
    for ( f0, q, gdb ) in formants:
        x = biquad_peaking( x, f0, q, gdb )
    x = lowpass_onepole( x, lowpass )
    if click > 0:
        cn = int( 0.004 * SR )
        rng = np.random.default_rng( RNG_SEED + 1 )
        c = rng.standard_normal( cn ) * np.exp( -np.arange( cn ) / ( cn / 6 ) )
        x[ :cn ] += c * click
    peak = np.max( np.abs( x ) )
    if peak > 0:
        x = x * ( 10 ** ( peak_db / 20 ) / peak )
    return x


# ---------------------------------------------------------------------------
# HORNS — each with its own personality (anti-monotone by design).
def synth_horn( spec ):
    total = spec[ 'dur' ]
    buf = np.zeros( int( total * SR ) )
    for ev in spec[ 'events' ]:
        sig = horn_burst(
            f0=ev[ 'f0' ], dur=ev[ 'dur' ], gain=ev.get( 'gain', 1.0 ),
            drive=spec[ 'drive' ], attack=spec[ 'attack' ], release=spec[ 'release' ],
            glide=ev.get( 'glide', spec.get( 'glide', 0.0 ) ),
            sag=spec.get( 'sag', 0.015 ), sag_s=spec.get( 'sag_s', 0.045 ),
            vib_hz=spec.get( 'vib_hz', 5.5 ), vib=spec.get( 'vib', 0.004 ),
            phase=ev.get( 'phase', 0.4 ),
        )
        mix_into( buf, sig, ev[ 't' ] )
    return finish( buf, spec[ 'formants' ], spec.get( 'lowpass', 5200 ) )


HORN_SPECS = {
    # Friendly sedan: double "beep-beep", second tap a hair lower in pitch.
    'horn-classic': {
        'events': [
            { 't': 0.00, 'f0': 420.0, 'dur': 0.34, 'gain': 1.0, 'phase': 0.4 },
            { 't': 0.00, 'f0': 500.0, 'dur': 0.34, 'gain': 0.9, 'phase': 2.1 },
            { 't': 0.44, 'f0': 420.0 * 0.97, 'dur': 0.30, 'gain': 0.95, 'phase': 1.2 },
            { 't': 0.44, 'f0': 500.0 * 0.97, 'dur': 0.30, 'gain': 0.85, 'phase': 3.0 },
        ],
        'formants': [ ( 1700, 1.4, 9.0 ), ( 3100, 2.0, 5.0 ) ],
        'drive': 2.4, 'dur': 1.18, 'attack': 0.008, 'release': 0.09,
    },
    # Big rig: one long low groan, growling tail with a slow downward drag.
    'horn-truck': {
        'events': [
            { 't': 0.00, 'f0': 233.0, 'dur': 1.10, 'gain': 1.0, 'glide': -0.055, 'phase': 0.4 },
            { 't': 0.00, 'f0': 350.0, 'dur': 1.05, 'gain': 0.55, 'glide': -0.05, 'phase': 2.1 },
            { 't': 0.00, 'f0': 117.0, 'dur': 1.10, 'gain': 0.35, 'phase': 3.3 },
        ],
        'formants': [ ( 800, 1.2, 10.0 ), ( 1600, 1.8, 6.0 ) ],
        'drive': 3.0, 'dur': 1.20, 'attack': 0.045, 'release': 0.22,
        'vib_hz': 4.5, 'vib': 0.008, 'sag_s': 0.09, 'lowpass': 4200,
    },
    # Sporty: excited rising chirp — pitch climbs ~10% through the blast.
    'horn-sport': {
        'events': [
            { 't': 0.00, 'f0': 545.0, 'dur': 0.52, 'gain': 1.0, 'glide': 0.10, 'phase': 0.4 },
            { 't': 0.00, 'f0': 660.0, 'dur': 0.50, 'gain': 0.85, 'glide': 0.09, 'phase': 1.9 },
        ],
        'formants': [ ( 2400, 1.5, 9.0 ), ( 4200, 2.2, 4.0 ) ],
        'drive': 2.8, 'dur': 0.62, 'attack': 0.004, 'release': 0.07,
        'vib_hz': 6.5, 'vib': 0.003, 'lowpass': 6000,
    },
    # Little hatchback: two quick polite meeps, second one scoots upward.
    'horn-compact': {
        'events': [
            { 't': 0.00, 'f0': 620.0, 'dur': 0.20, 'gain': 1.0, 'phase': 0.4 },
            { 't': 0.26, 'f0': 620.0, 'dur': 0.22, 'gain': 1.05, 'glide': 0.06, 'phase': 1.7 },
        ],
        'formants': [ ( 1900, 1.6, 8.0 ), ( 3400, 2.4, 3.0 ) ],
        'drive': 1.8, 'dur': 0.55, 'attack': 0.006, 'release': 0.06,
        'vib_hz': 6.0, 'vib': 0.004, 'lowpass': 5500,
    },
}


# ---------------------------------------------------------------------------
# SIRENS — swept / alternating frequency contours (the anti-monotone extreme).
def siren_signal( freq_fn, dur, gain, drive, attack=0.015, release=0.12, phase=0.0 ):
    n = int( dur * SR )
    t = np.arange( n, dtype=np.float64 ) / SR
    freq_t = freq_fn( t )
    x = 0.7 * diaphragm( freq_t, phase ) + 0.3 * diaphragm( freq_t * 1.006, phase + 1.1, 24 )
    x = np.tanh( drive * x ) / math.tanh( drive )
    return x * make_env( n, attack, release, 0.02, phase ) * gain


def synth_police():
    """Yelp: fast 750→1500→750 sweep cycles (~2 per second)."""
    def f( t ):
        return 750.0 + 720.0 * ( 0.5 - 0.5 * np.cos( 2 * math.pi * t / 0.62 ) )
    return finish( siren_signal( f, 2.3, 1.0, 2.6, phase=0.3 ),
                   [ ( 1900, 1.5, 9.0 ), ( 3600, 2.0, 4.0 ) ], lowpass=6200, click=0.03 )


def synth_ambulance():
    """Hi-lo: alternates 610 / 915 Hz with a short portamento between steps."""
    def f( t ):
        frac = ( t % 0.60 ) / 0.60
        hi = ( np.floor( t / 0.60 ).astype( int ) % 2 ) == 1
        glide_zone = np.clip( frac / 0.07, 0, 1 )  # 40ms slide after each switch
        base = np.where( hi, 915.0, 610.0 )
        prev = np.where( hi, 610.0, 915.0 )
        return prev + ( base - prev ) * glide_zone
    return finish( siren_signal( f, 2.4, 1.0, 1.6, phase=0.3 ),
                   [ ( 1500, 1.5, 8.0 ), ( 2800, 2.0, 4.0 ) ], lowpass=5600, click=0.03 )


def synth_fire():
    """Fire truck: slow low wail + two layered air-horn blasts over it."""
    n = int( 2.6 * SR )
    buf = np.zeros( n )
    def wail_f( t ):
        return 380.0 + 380.0 * ( 0.5 - 0.5 * np.cos( 2 * math.pi * t / 1.6 ) )
    mix_into( buf, siren_signal( wail_f, 2.6, 0.8, 2.2, attack=0.05, release=0.25, phase=0.3 ), 0.0 )
    for ( t0, g ) in [ ( 0.30, 0.9 ), ( 1.50, 1.0 ) ]:
        mix_into( buf, horn_burst( 233.0, 0.42, g, 3.0, 0.02, 0.10, glide=-0.04, phase=0.4 ), t0 )
        mix_into( buf, horn_burst( 350.0, 0.42, g * 0.6, 3.0, 0.02, 0.10, glide=-0.04, phase=2.1 ), t0 )
        mix_into( buf, horn_burst( 117.0, 0.42, g * 0.4, 3.0, 0.02, 0.10, phase=3.3 ), t0 )
    return finish( buf, [ ( 900, 1.3, 9.0 ), ( 1800, 1.8, 6.0 ) ], lowpass=5200, click=0.05 )


SIREN_SPECS = {
    'siren-police': synth_police,
    'siren-ambulance': synth_ambulance,
    'siren-fire': synth_fire,
}


# ---------------------------------------------------------------------------
def write_wav( path, x ):
    data = ( x * 32767 ).astype( '<i2' )
    with wave.open( path, 'wb' ) as w:
        w.setnchannels( 1 )
        w.setsampwidth( 2 )
        w.setframerate( SR )
        w.writeframes( data.tobytes() )


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
            subprocess.run( [ 'ffmpeg', '-y', '-loglevel', 'error', '-i', wav,
                              '-c:a', 'libvorbis', '-q:a', '4', ogg ], check=True )
            print( f"  ✓ { name }.ogg ({ os.path.getsize( ogg ) // 1024 } KB)" )
        for name, fn in SIREN_SPECS.items():
            wav = os.path.join( tmp, name + '.wav' )
            ogg = os.path.join( out, name + '.ogg' )
            write_wav( wav, fn() )
            subprocess.run( [ 'ffmpeg', '-y', '-loglevel', 'error', '-i', wav,
                              '-c:a', 'libvorbis', '-q:a', '4', ogg ], check=True )
            print( f"  ✓ { name }.ogg ({ os.path.getsize( ogg ) // 1024 } KB)" )
    finally:
        shutil.rmtree( tmp, ignore_errors=True )


if __name__ == '__main__':
    main()
