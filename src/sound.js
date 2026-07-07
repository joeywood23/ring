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
		this.master.connect( this.ctx.destination );

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

		this.running = true;
		this._pushTimer = 0;

	}

	stop() {

		if ( ! this.running ) return;

		const t = this.ctx.currentTime;
		for ( const loop of [ this.roll, this.carve, this.skid, this.grind ] ) {

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
