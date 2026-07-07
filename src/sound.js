// Procedural skateboard audio — rolling, carving, skidding, pushing, ollies
// and landings are synthesized at runtime from filtered noise and simple
// oscillators; no audio files are loaded.

const PUSH_INTERVAL = 0.65; // seconds between foot scuffs while pushing

export class SkateAudio {

	constructor() {

		this.ctx = null;
		this.running = false;
		this._pushTimer = 0;

	}

	// Lazily created so the AudioContext is born from the user gesture that
	// starts skate mode — browsers block autoplaying contexts.
	_ensure() {

		if ( this.ctx ) return;

		const Ctx = window.AudioContext || window.webkitAudioContext;
		if ( ! Ctx ) return;

		this.ctx = new Ctx();

		const len = this.ctx.sampleRate * 2;
		const buf = this.ctx.createBuffer( 1, len, this.ctx.sampleRate );
		const data = buf.getChannelData( 0 );
		for ( let i = 0; i < len; i ++ ) data[ i ] = Math.random() * 2 - 1;
		this.noise = buf;

		this.master = this.ctx.createGain();
		this.master.gain.value = 0.6;

		// everything runs through this lowpass so submerging muffles the world
		this.out = this.ctx.createBiquadFilter();
		this.out.type = 'lowpass';
		this.out.frequency.value = 20000;
		this.master.connect( this.out );
		this.out.connect( this.ctx.destination );

	}

	setUnderwater( on ) {

		if ( ! this.ctx ) return;
		this.out.frequency.setTargetAtTime( on ? 550 : 20000, this.ctx.currentTime, 0.12 );

	}

	// entering / leaving the water, scaled by impact speed
	splash( impact = 1 ) {

		if ( ! this.running ) return;

		const t = this.ctx.currentTime;
		const k = Math.min( impact / 8, 1 );

		const body = this.ctx.createBufferSource();
		body.buffer = this.noise;
		body.playbackRate.value = 0.7;
		const bodyFilter = this._filter( 'lowpass', 900, 0.7 );
		const bodyGain = this.ctx.createGain();
		bodyGain.gain.setValueAtTime( 0, t );
		bodyGain.gain.linearRampToValueAtTime( 0.25 + 0.45 * k, t + 0.02 );
		bodyGain.gain.exponentialRampToValueAtTime( 0.001, t + 0.45 );
		body.connect( bodyFilter );
		bodyFilter.connect( bodyGain );
		bodyGain.connect( this.master );
		body.start( t );
		body.stop( t + 0.5 );

		const spray = this.ctx.createBufferSource();
		spray.buffer = this.noise;
		const sprayFilter = this._filter( 'highpass', 1800, 0.7 );
		const sprayGain = this.ctx.createGain();
		sprayGain.gain.setValueAtTime( 0.12 + 0.15 * k, t );
		sprayGain.gain.exponentialRampToValueAtTime( 0.001, t + 0.3 );
		spray.connect( sprayFilter );
		sprayFilter.connect( sprayGain );
		sprayGain.connect( this.master );
		spray.start( t );
		spray.stop( t + 0.32 );

	}

	// one soft paddle stroke
	stroke() {

		if ( ! this.running ) return;

		const t = this.ctx.currentTime;
		const src = this.ctx.createBufferSource();
		src.buffer = this.noise;
		src.playbackRate.value = 0.45 + Math.random() * 0.15;

		const filter = this._filter( 'bandpass', 420, 0.8 );
		const gain = this.ctx.createGain();
		gain.gain.setValueAtTime( 0, t );
		gain.gain.linearRampToValueAtTime( 0.15, t + 0.06 );
		gain.gain.exponentialRampToValueAtTime( 0.001, t + 0.35 );

		src.connect( filter );
		filter.connect( gain );
		gain.connect( this.master );
		src.start( t );
		src.stop( t + 0.37 );

	}

	_filter( type, freq, q ) {

		const f = this.ctx.createBiquadFilter();
		f.type = type;
		f.frequency.value = freq;
		f.Q.value = q;
		return f;

	}

	_noiseLoop( filter, rate ) {

		const src = this.ctx.createBufferSource();
		src.buffer = this.noise;
		src.loop = true;
		src.playbackRate.value = rate;

		const gain = this.ctx.createGain();
		gain.gain.value = 0;

		src.connect( filter );
		filter.connect( gain );
		gain.connect( this.master );
		src.start();

		return { src, filter, gain };

	}

	start() {

		this._ensure();
		if ( ! this.ctx || this.running ) return;
		if ( this.ctx.state === 'suspended' ) this.ctx.resume();

		// rolling: low rumble that opens up and rises in pitch with speed
		this.roll = this._noiseLoop( this._filter( 'lowpass', 200, 0.7 ), 0.7 );

		// carve: mid-band "swish" driven by lateral wheel slip while turning
		this.carve = this._noiseLoop( this._filter( 'bandpass', 480, 1.2 ), 0.8 );

		// skid: bright scrape while braking
		this.skid = this._noiseLoop( this._filter( 'bandpass', 2200, 0.7 ), 1.4 );

		// grind: resonant metallic scrape while on a rail
		this.grind = this._noiseLoop( this._filter( 'bandpass', 2700, 5 ), 1.5 );

		// wind: rises with airspeed (flight, big airs)
		this.wind = this._noiseLoop( this._filter( 'lowpass', 400, 0.5 ), 0.8 );

		this.running = true;
		this._pushTimer = 0;

	}

	stop() {

		if ( ! this.running ) return;

		const t = this.ctx.currentTime;
		for ( const loop of [ this.roll, this.carve, this.skid, this.grind, this.wind ] ) {

			// quick fade before stopping so the loop doesn't end on a click
			loop.gain.gain.setTargetAtTime( 0, t, 0.04 );
			loop.src.stop( t + 0.3 );

		}

		this.running = false;

	}

	update( dt, s ) {

		if ( ! this.running ) return;

		const t = this.ctx.currentTime;

		const rollLevel = s.grounded ? Math.min( s.speed / 10, 1 ) * 0.4 : 0;
		this.roll.gain.gain.setTargetAtTime( rollLevel, t, 0.08 );
		this.roll.filter.frequency.setTargetAtTime( 140 + 90 * s.speed, t, 0.1 );
		this.roll.src.playbackRate.setTargetAtTime( 0.6 + s.speed / 25, t, 0.1 );

		const carveLevel = s.grounded
			? Math.min( s.slip / 4, 1 ) * Math.min( s.speed / 8, 1 ) * 0.35
			: 0;
		this.carve.gain.gain.setTargetAtTime( carveLevel, t, 0.06 );

		const skidLevel = s.grounded && s.braking ? Math.min( s.speed / 12, 1 ) * 0.5 : 0;
		this.skid.gain.gain.setTargetAtTime( skidLevel, t, 0.03 );

		const grindLevel = s.grinding ? Math.min( s.speed / 10, 1 ) * 0.45 : 0;
		this.grind.gain.gain.setTargetAtTime( grindLevel, t, 0.03 );

		const wind = s.wind || 0;
		const windLevel = Math.pow( Math.min( wind / 28, 1 ), 1.5 ) * 0.45;
		this.wind.gain.gain.setTargetAtTime( windLevel, t, 0.15 );
		this.wind.filter.frequency.setTargetAtTime( 300 + wind * 25, t, 0.2 );

		if ( s.grounded && s.pushing ) {

			this._pushTimer -= dt;
			if ( this._pushTimer <= 0 ) {

				this._scuff();
				this._pushTimer = PUSH_INTERVAL * ( 0.9 + Math.random() * 0.25 );

			}

		} else {

			// next push lands its scuff almost immediately
			this._pushTimer = Math.min( this._pushTimer, 0.1 );

		}

	}

	// one foot-push scrape against the pavement
	_scuff() {

		const t = this.ctx.currentTime;
		const src = this.ctx.createBufferSource();
		src.buffer = this.noise;
		src.playbackRate.value = 0.75 + Math.random() * 0.4;

		const filter = this._filter( 'bandpass', 700 * ( 0.85 + Math.random() * 0.3 ), 0.6 );
		const gain = this.ctx.createGain();
		gain.gain.setValueAtTime( 0, t );
		gain.gain.linearRampToValueAtTime( 0.45, t + 0.03 );
		gain.gain.exponentialRampToValueAtTime( 0.001, t + 0.3 );

		src.connect( filter );
		filter.connect( gain );
		gain.connect( this.master );
		src.start( t );
		src.stop( t + 0.32 );

	}

	// one soft wing-beat whoosh
	flap() {

		if ( ! this.running ) return;

		const t = this.ctx.currentTime;
		const src = this.ctx.createBufferSource();
		src.buffer = this.noise;
		src.playbackRate.value = 0.45 + Math.random() * 0.15;

		const filter = this._filter( 'bandpass', 380, 0.8 );
		const gain = this.ctx.createGain();
		gain.gain.setValueAtTime( 0, t );
		gain.gain.linearRampToValueAtTime( 0.26, t + 0.05 );
		gain.gain.exponentialRampToValueAtTime( 0.001, t + 0.2 );

		src.connect( filter );
		filter.connect( gain );
		gain.connect( this.master );
		src.start( t );
		src.stop( t + 0.22 );

	}

	// single footstep for the pedestrian modes; harder when running
	step( hard ) {

		if ( ! this.running ) return;

		const t = this.ctx.currentTime;
		const src = this.ctx.createBufferSource();
		src.buffer = this.noise;
		src.playbackRate.value = 0.6 + Math.random() * 0.3;

		const filter = this._filter( 'lowpass', hard ? 700 : 480, 0.7 );
		const gain = this.ctx.createGain();
		gain.gain.setValueAtTime( hard ? 0.3 : 0.16, t );
		gain.gain.exponentialRampToValueAtTime( 0.001, t + ( hard ? 0.09 : 0.07 ) );

		src.connect( filter );
		filter.connect( gain );
		gain.connect( this.master );
		src.start( t );
		src.stop( t + 0.1 );

	}

	// metallic clank when the trucks lock onto a rail
	grindStart() {

		if ( ! this.running ) return;

		const t = this.ctx.currentTime;
		for ( const freq of [ 2100, 3150 ] ) {

			const osc = this.ctx.createOscillator();
			osc.frequency.value = freq;
			const og = this.ctx.createGain();
			og.gain.setValueAtTime( 0.16, t );
			og.gain.exponentialRampToValueAtTime( 0.001, t + 0.09 );
			osc.connect( og );
			og.connect( this.master );
			osc.start( t );
			osc.stop( t + 0.1 );

		}

		const src = this.ctx.createBufferSource();
		src.buffer = this.noise;
		const filter = this._filter( 'highpass', 2000, 0.7 );
		const gain = this.ctx.createGain();
		gain.gain.setValueAtTime( 0.3, t );
		gain.gain.exponentialRampToValueAtTime( 0.001, t + 0.05 );
		src.connect( filter );
		filter.connect( gain );
		gain.connect( this.master );
		src.start( t );
		src.stop( t + 0.07 );

	}

	// tail-snap pop on ollie
	jump() {

		if ( ! this.running ) return;

		const t = this.ctx.currentTime;

		const osc = this.ctx.createOscillator();
		osc.frequency.setValueAtTime( 170, t );
		osc.frequency.exponentialRampToValueAtTime( 70, t + 0.09 );
		const og = this.ctx.createGain();
		og.gain.setValueAtTime( 0.5, t );
		og.gain.exponentialRampToValueAtTime( 0.001, t + 0.12 );
		osc.connect( og );
		og.connect( this.master );
		osc.start( t );
		osc.stop( t + 0.14 );

		const src = this.ctx.createBufferSource();
		src.buffer = this.noise;
		const filter = this._filter( 'highpass', 1500, 0.7 );
		const gain = this.ctx.createGain();
		gain.gain.setValueAtTime( 0.25, t );
		gain.gain.exponentialRampToValueAtTime( 0.001, t + 0.06 );
		src.connect( filter );
		filter.connect( gain );
		gain.connect( this.master );
		src.start( t );
		src.stop( t + 0.08 );

	}

	// wheels-down thump, scaled by impact speed
	land( impact ) {

		if ( ! this.running || impact < 1.2 ) return;

		const t = this.ctx.currentTime;
		const k = Math.min( impact / 8, 1 );

		const osc = this.ctx.createOscillator();
		osc.frequency.setValueAtTime( 110, t );
		osc.frequency.exponentialRampToValueAtTime( 45, t + 0.12 );
		const og = this.ctx.createGain();
		og.gain.setValueAtTime( 0.6 * k, t );
		og.gain.exponentialRampToValueAtTime( 0.001, t + 0.16 );
		osc.connect( og );
		og.connect( this.master );
		osc.start( t );
		osc.stop( t + 0.18 );

		const src = this.ctx.createBufferSource();
		src.buffer = this.noise;
		src.playbackRate.value = 0.8;
		const filter = this._filter( 'lowpass', 500, 0.7 );
		const gain = this.ctx.createGain();
		gain.gain.setValueAtTime( 0.35 * k, t );
		gain.gain.exponentialRampToValueAtTime( 0.001, t + 0.1 );
		src.connect( filter );
		filter.connect( gain );
		gain.connect( this.master );
		src.start( t );
		src.stop( t + 0.12 );

	}

}
