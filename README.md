# Cosmos

A universe at 1:1 scale that runs in the browser (WebGL2, no build step, no dependencies): the real Solar System,
real stars and nebulae around the Sun, and a procedural galaxy and universe beyond. You can fly from a planet's
surface out to intergalactic space without a loading screen.

It is also a physics simulation across all of time: merge black holes and hear the gravitational waves, form the
Moon in a giant impact, detonate white dwarfs (V for the sandbox); fast-forward to watch ice ages come and go, the
continents drift, Betelgeuse explode, the Sun circle the Galaxy, Andromeda collide with the Milky Way, the Sun become
a red giant and the other galaxies recede beyond our horizon (U for the timeline).

**Play it:** https://matthewjbarnett.github.io/cosmos/ (press T for a guided tour, H for help)

## Gallery

Unedited frames from the app, rendered headless on a machine without a GPU (software renderer, reduced settings).

| | |
| --- | --- |
| ![Earth](docs/earth.jpg) Earth with real colour, elevation and clouds | ![Europe at night](docs/europe_night.jpg) Europe at night (Black Marble city lights) |
| ![Eclipse](docs/eclipse2024.jpg) Totality, 8 April 2024, from the computed centreline | ![Milky Way](docs/milkyway_atacama.jpg) The real Milky Way core from the Atacama |
| ![Alps](docs/alps.jpg) The Alps: real elevation plus procedural detail | ![Valles Marineris](docs/valles.jpg) Valles Marineris in the afternoon |
| ![Aurora](docs/aurora.jpg) Aurora over northern Canada | ![Moon](docs/moon_surface.jpg) Near Tycho, Earth in the sky |
| ![Saturn](docs/saturn.jpg) Saturn in 2017 with Cassini ring transparency | ![Bodies](docs/bodies.jpg) Mercury to Mars from real maps |
| ![TRAPPIST-1 e](docs/trappist.jpg) TRAPPIST-1 e under its red dwarf | ![Black hole](docs/bh.jpg) Sagittarius A* |
| ![Cygnus X-1](docs/cygx1.jpg) Cygnus X-1 lensing its supergiant companion | ![Orion](docs/orion.jpg) Orion Nebula |
| ![Andromeda](docs/m31.jpg) Andromeda | ![Galaxy](docs/galaxy2.jpg) The Milky Way from above |
| ![Crescent Moon](docs/crescent_earthshine.jpg) Crescent Moon at dusk, 12 May 2024, with earthshine | ![Venus](docs/venus.jpg) Venus |
| ![Refracted sunset](docs/refracted_sunset.jpg) Sunset over the Atlantic: refraction lifts and flattens the Sun | ![Night orbit](docs/night_orbit.jpg) Moonlit night from orbit with airglow |
| ![Io shadow](docs/io_shadow.jpg) Io's shadow on Jupiter, 20 October 2026 | ![Winter](docs/winter.jpg) Europe in January |
| ![Halley](docs/halley.jpg) Halley's Comet, February 1986: dust and ion tails | ![Alps at dusk](docs/alps_dusk.jpg) Dusk over the Alps |
| ![Crab Nebula](docs/crab.jpg) Crab Nebula with its pulsar | ![Ocean](docs/ocean.jpg) Open ocean in the late afternoon |
| ![Blood moon](docs/blood_moon.jpg) Total lunar eclipse, 14 March 2025, found by the eclipse finder | ![Forest](docs/forest.jpg) Black Forest from 60 m |
| ![Cumulus](docs/cumulus.jpg) Cumulus over the Amazon from 5 km | ![Overcast sunset](docs/overcast_sunset.jpg) Overcast sunset over Norway |
| ![Mars sunset](docs/mars_sunset.jpg) Blue sunset at Gale crater, Mars | ![Milky Way](docs/milkyway.jpg) The Milky Way's core from the Solar System |
| ![ISS view](docs/iss_view.jpg) From 400 km over the Atlantic | ![Deep field](docs/web.jpg) Intergalactic deep field |
| ![Sahara dunes](docs/sahara_dunes.jpg) Grand Erg Oriental, Sahara, from 250 m | ![Binary black hole](docs/bbh.jpg) Sandbox: 36 + 29 M☉ black holes a second before merging, lensing their own trails and the spacetime grid |
| ![Eccentric binary](docs/bbh_eccentric.jpg) An eccentric black hole binary: general relativity turns the orbit into a rosette | ![Mars ring](docs/mars_ring.jpg) Mars 45 million years from now, ringed by the debris of Phobos |
| ![Betelgeuse](docs/betelgeuse_sn.jpg) Betelgeuse goes supernova (~100,000 years from now), seen from Earth | ![Red giant from Mars](docs/red_giant_mars.jpg) The red giant Sun over Mars, 7.6 billion years from now |
| ![Planetary nebula](docs/sun_pn.jpg) The Sun's planetary nebula around its newborn white dwarf | ![Collision](docs/m31_collision.jpg) Milky Way and Andromeda after their first passage (N-body) |
| ![Andromeda approaching](docs/m31_sky.jpg) Andromeda looming in the sky of the Solar System in 3.4 billion years | ![Sun's orbit](docs/sun_orbit.jpg) The Sun's orbit around the Milky Way |
| ![Rogue black hole](docs/rogue_bh.jpg) A rogue black hole crosses the Solar System: the planets' trails 15 years later | ![Relativistic flight](docs/relativistic.jpg) Flying at 0.9 c: the sky crowds forward, blueshifted and beamed |
| ![Last ice age](docs/ice_age.jpg) 20,000 years ago: ice sheets over North America, the sea 120 m lower (Milankovitch model) | ![Drifting continents](docs/drift.jpg) 80 million years from now: Australia has drifted north into the western Pacific |
| ![Moon-forming impact](docs/theia_impact.jpg) Sandbox: hours after Theia hits the young Earth, molten rock winds into a disk | ![Merging shadows](docs/bbh_shadow.jpg) 12 ms before a black hole merger: light traced through both holes at once, their shadows fuse |

## Run

    cd ~/projects/cosmos
    ./run.sh          # serves http://localhost:8642/
    ./run.sh show     # also opens it on the desktop session (display :20)

Needs a browser with WebGL2 and float render targets (desktop Chrome, Edge, Firefox or Safari with a GPU).
Benchmark: Settings → Run benchmark (or open `?bench`) flies through seven scenes and get a copyable report of frame rate and GPU time per pass.
Quality presets: add `?q=low`, `?q=medium`, `?q=high` (default) or `?q=ultra` (for fast GPUs such as Apple M-series Pro/Max). Dynamic resolution is on by default.
Start somewhere else with `?goto=Saturn&date=2017-06-01` (any name the search box accepts), or on a surface with
`?goto=Earth&land=46.0,7.6&date=2024-06-20T16:30Z` (latitude, longitude). The Link button copies such a URL for where you are.

## Controls

| Input | Action |
| --- | --- |
| Left drag | Look around |
| Right drag | Orbit the selected object |
| Wheel | Change flight speed (Ctrl + wheel zooms to the selection) |
| W A S D, R F | Fly (Shift faster, Ctrl slower) |
| Q E, arrows | Roll, turn |
| Click, double click | Select, go to |
| G, L, C | Go to, land on, look at the selection |
| T | Guided tour (T again for the next stop, Esc to stop) |
| Space, `,` `.` J `\` | Pause, slower, faster, reverse, real time |
| 0 to 9 | Sun, Mercury ... Pluto |
| Y | Orbit mode: enter a circular orbit, W A S D R F fire thrusters (Newtonian two-body motion) |
| Shift+E | Next eclipse: jumps to the next central solar or umbral lunar eclipse and watches it from the centreline (or under the Moon) |
| U | Timeline of future events (Betelgeuse, Andromeda, the Sun's death...) with Go buttons |
| V | Physics sandbox: black holes, neutron stars, stars and planets under full gravity |
| M | Relativistic flight: speed below c, with aberration, Doppler shift, beaming and time dilation |
| B | Save the current view (Saved menu) |
| Tab | System browser |
| O, N, K | Orbits, labels, constellation figures |
| `[` `]` | Exposure |
| Z, X | Zoom the field of view |
| F2, F3, P | Hide the interface, GPU timings per pass, save a screenshot |
| H | Help |

On touch screens: one finger looks around, pinch moves toward or away from the selection, and two on-screen buttons fly forward and back.

The Places menu jumps to planets, exoplanet systems, nebulae, black holes and galaxies. Explore finds a random star,
an Earth-like planet with life, a ringed planet, a giant star or another galaxy. The Saved menu keeps views you save with B.

## Physics and deep time

The clock runs from slow motion (1/1000) to 10 billion years per second (the Rate menu, or `,` and `.`), from the
Big Bang to 100 trillion years from now. The Timeline (U) lists what happens on the way and slows the clock down
for each event (untick "Slow down for events" to race through). Dates marked "estimate" are uncertain in reality.

- **Physics sandbox (V):** pick a scenario or place bodies yourself (click to place on a circular orbit, drag to
  give a velocity). Gravity is N-body with post-Newtonian corrections for every pair: 1PN (precession, the
  innermost stable orbit) and 2.5PN radiation reaction, which shrinks orbits exactly as the Peters formula says.
  Black hole mergers use numerical relativity fits for the radiated energy, final spin, recoil kick and the
  ringdown frequency and damping (GW150914-like masses give 61.9 M☉, spin 0.68, 3.1 M☉ radiated, 275 Hz,
  as measured). The scope shows the strain h₊ at 100 Mpc from the quadrupole formula; Sound plays the chirp.
  The spacetime grid shows each mass's well plus the actual retarded wave field (read at t − r/c), and is bent
  by the black holes' lensing; a pair of holes is ray traced through their combined gravity, so near merger their
  shadows stretch and fuse. Neutron star mergers collapse to a black hole and make a kilonova; stars that pass
  inside a black hole's tidal radius are shredded into debris that falls back at the t^−5/3 rate and lights an
  accretion disk. Stars that touch merge. Time runs backwards too (snapshots, then re-integration).
  Black holes can spin (aligned with the orbit): 1.5PN spin-orbit coupling delays the merger ("orbital hang-up")
  and the remnant spin, radiated energy and recoil follow numerical relativity fits.
  Scenarios: GW150914-like merger, rapidly spinning black holes, unequal masses (recoil), black holes released from rest (head-on), an
  eccentric binary (GR rosette, wave bursts), neutron star merger with kilonova and gamma-ray burst jet,
  a supermassive pair (LISA band), a tidal disruption, a rogue black hole through the real Solar System,
  the figure-eight and Pythagorean three-body problems, a circumbinary planet, the Moon-forming impact, colliding
  white dwarfs, or empty space. White dwarfs that collide above 1.2 M☉ detonate as a Type Ia supernova whose light
  is the decay of nickel-56 and cobalt-56 (peak magnitude −19.1 for 0.6 M☉ of nickel).
  Giant impacts between rocky planets merge them into a molten, fast-spinning body and throw a hot debris disk
  into orbit (about 2% of the mass, after SPH results); material outside the Roche limit gathers into a moon
  within weeks (Ida et al. 1997) while the inner disk spreads and rains back. Selecting a black hole shows its
  Hawking temperature and evaporation time.
- **Moving stars:** catalogue stars follow their measured space velocities (Barnard's Star passes 3.75 ly from
  the Sun in 11,700 years, Alpha Centauri 2.9 ly in 27,600 years, Gliese 710 crosses the Oort cloud in 1.3 Myr),
  so constellations distort; procedural stars stream through the rotating spiral pattern with the Galaxy's
  rotation curve and their own random motions. After a few million years the catalogue fades into the field.
- **The Sun's galactic orbit:** an epicyclic orbit (period 218 Myr, ±290 pc in radius, ±92 pc vertically) drawn
  at galaxy level; the spiral pattern turns at 25 km/s/kpc, the stars faster, the Solar System keeps its own
  inertial orientation.
- **Supernovae:** massive procedural stars live, explode and are replaced, with light-travel delay, Type II-P
  and Ib/c light curves averaged over each frame (a one-year flash still registers at a million years per
  second), and remnants that expand (free expansion, then Sedov-Taylor) and fade. Betelgeuse (estimated
  100,000 years) and Antares (estimated 600,000 years) explode on schedule: from Earth Betelgeuse peaks at
  magnitude −11, lights the night like a quarter Moon, and if you fly there during the explosion the star swells
  into a fireball tens of AU across before leaving a neutron star. Real nebulae age: the Crab and Veil expand and fade, H II regions disperse in a few Myr.
- **Seen from Earth:** meteor showers on their real dates (Quadrantids, Lyrids, Eta Aquariids, Perseids, Orionids,
  Leonids, Geminids, plus sporadics, more after midnight) streak away from their radiants at ~100 km; zodiacal light
  and the gegenschein glow along the ecliptic at dark sites; city lights and light pollution belong to the era of
  electric lighting.
- **Variable stars:** Algol's eclipses, Mira, Beta Lyrae, Epsilon Aurigae's two-year eclipse every 27 years,
  Zeta Geminorum (a Cepheid) and Betelgeuse's semi-regular pulsation.
- **The Sun's life:** a solar evolutionary track (Sackmann et al. 1993; Schröder & Smith 2008): brightening on
  the main sequence, subgiant, red giant tip at 256 R☉ and 2,700 L☉, the helium flash, horizontal branch,
  AGB, a planetary nebula lit by the contracting core, and a cooling white dwarf. Mass loss widens the planets'
  orbits; Mercury, Venus and Earth are engulfed. The 11-year activity cycle changes sunspots and aurorae.
- **Earth and Moon over time:** precession of the axis (Vega is the pole star in 13,700 CE) and the 41,000 year
  obliquity cycle; tidal recession of the Moon (total solar eclipses end in ~600 Myr) and the lengthening day;
  a brightening Sun dries the oceans (exposing the real sea floor), kills the biosphere and, near the red
  giant tip, heats rock until it glows (Mars too).
- **Orbits over millions of years and ice ages:** beyond ±5,000 years the planets' orbits follow Laplace-Lagrange
  secular theory, solved at load from the masses and orbit sizes (plus general relativity): perihelia and nodes
  precess and eccentricities trade back and forth (Earth's swings between ~0 and 0.06). Midsummer sunlight at
  65° N from the orbit, tilt and precession drives an ice volume model (Imbrie & Imbrie 1980): ice sheets spread
  over Canada and Scandinavia to their Last Glacial Maximum limits and the sea falls up to 125 m, exposing the
  real continental shelves (Beringia, Doggerland, Sundaland). It peaks 18,000 years ago and is clear by 9,000
  years ago, close to the real record. The next glaciation comes ~58,000 years from now (held off for 50,000
  years by human CO₂).
- **Drifting continents:** Earth's plates (Bird 2003 outlines) turn about their present Euler poles (NNR-NUVEL-1A):
  the Atlantic widens, Australia heads for Southeast Asia, the Pacific shrinks; gaps between diverging plates fill
  with new sea floor. Present motions are extrapolated to +100 Myr (and back to -50 Myr), then held.
- **Time-lapse at a planet:** at fast rates the clock advances in whole days (and, faster still, whole orbits),
  like a camera taking one photo per night, so the lit face holds still instead of strobing.
- **Andromeda:** M31's orbit (765 kpc, −109 km/s, dynamical friction) gives a first passage at 3.7 Gyr
  (35 kpc), a second at 5.2 Gyr and a merger at 5.9 Gyr, close to van der Marel et al. 2012. From 2.6 Gyr the
  two galaxies are a 65,536 particle restricted N-body simulation on the GPU (leapfrog, time reversible); the
  Sun is a tracer particle, so you can watch the sky from the Solar System as Andromeda arrives.
- **Moons and rings:** Phobos spirals in and breaks into a ring around Mars in ~40 Myr; Triton is torn apart into a
  ring around Neptune in ~3.6 Gyr; Saturn's rings rain onto the planet and are gone in ~300 Myr.
- **The end of the stellar era:** once star formation stops, the brightest stars burn out first; after tens of
  billions of years only red dwarfs and white dwarfs remain, and by 100 trillion years the last stars fade.
- **Relativistic flight (M):** flying below light speed, the sky aberrates towards the direction of travel,
  blueshifts and brightens ahead (Doppler beaming), reddens behind; the outside clock runs fast by γ.
- **Expanding universe:** flat ΛCDM (Planck 2018). Galaxies beyond the Local Group are seen with light travel
  time: they shrink, redden and dim with (1+z)⁴ as they recede, and freeze at our event horizon; after ~150 Gyr
  nothing beyond the Local Group is visible. The HUD shows the age of the universe and the CMB temperature.

## What is simulated

**Real data**
- **Stars:** 91,793 stars from the HYG catalogue (to magnitude 9.5) at their real 3D positions, with names,
  spectral types, search and visits. Constellation figures (K) are drawn in 3D, so they distort as you travel.
  Procedural stars fill in only where the catalogue is incomplete.
- **Solar System surfaces:** Earth (Blue Marble colour, ETOPO elevation and bathymetry, coastlines, Black Marble city
  lights, real cloud cover), the Moon (LROC colour, LOLA elevation), Mars (Viking colour, MOLA elevation), Mercury,
  Io, Europa, Ganymede, Callisto, Titan, Enceladus, Pluto, Charon, Ceres, the giant planets and Saturn's rings.
  Grayscale mosaics are calibrated to each body's real albedo. Procedural detail continues below map resolution
  (forest and fields, rock on steep slopes, snow line, ridges).
- **Eclipse finder (Shift+E):** finds solar and lunar eclipses, including partial and penumbral ones (2024 to 2026 checked
  against NASA: times within about a minute) and takes you to watch it. The eclipsed Moon is lit red by light refracted
  through Earth's atmosphere.
- **Ephemerides:** planets from JPL approximate elements with secular rates, the Moon from Meeus' lunar theory,
  Jupiter's Galilean moons from Meeus ch. 44, IAU pole directions and prime meridians, Earth rotation from sidereal
  time; beyond ±5,000 years the orbits evolve by Laplace-Lagrange secular theory. Phases and eclipses happen when they really do: eclipse paths land within ~20 to 65 km of NASA's
  greatest-eclipse points for 2017, 2024, 2026 and 2027.
- **Exoplanets:** observed systems at Proxima Centauri, TRAPPIST-1, Barnard's Star, 51 Pegasi, Epsilon Eridani and
  Tau Ceti; Sirius B; asteroids and dwarf planets (Vesta, Pallas, Hygiea, Juno, Eros, Bennu, Makemake, Haumea, Sedna).
- **Tectonic plates:** plate outlines from Bird (2003), PB2002 (GeoJSON from github.com/fraxen/tectonicplates), rasterised
  to `data/planets/earth_plates.png` with the microplates merged; Euler poles from NNR-NUVEL-1A.
- **Milky Way from near the Sun:** the ESO all-sky panorama with point stars removed, blended into the procedural
  galaxy model a few hundred parsecs out.

**Simulation and rendering**
- **Scale hierarchy:** camera position is kept at three levels (Mpc, parsecs, metres) in double precision and
  everything is drawn relative to the camera, from 1.7 m above a surface to intergalactic space.
- **Procedural universe:** galaxies in a cosmic web with Hubble types, stars from the luminosity function in
  magnitude-binned grids, and star systems with binaries, rocky and giant planets, moons, rings and belts.
- **Planet surfaces:** a quadtree cube-sphere with GPU baked tiles; noise is evaluated per octave in tile-local
  coordinates supplied in double precision, so detail holds down to centimetres.
- **Atmospheres:** physically based scattering (Hillaire 2020 LUTs) with coefficients from pressure, temperature,
  gravity and composition; ozone and methane absorption; Martian dust with wavelength-dependent phase; planet shadow,
  eclipses and cloud shadows in the air (crepuscular rays).
- **Clouds:** volumetric ray marching driven by the real cloud map on Earth (Earth-like exoplanets borrow its
  morphology), cloud cells whose area matches the observed cover, billowy cumulus from GPU-baked Worley noise, light
  marched through the whole layer (overcast bases stay grey at sunset), lightning in storm clouds at night.
- **Ground:** dune fields wherever the real map shows sand seas; instanced trees where the land is green (stands, clearings, conifers and broadleaf), boulders on barren
  ground, degraded small craters, ice and snow textures, triaxial shapes for small moons and asteroids.
- **Oceans:** a directional wind-wave spectrum near the camera that becomes microfacet roughness with distance,
  Fresnel reflection of a horizon-weighted sky, the sun's glitter path, depth-dependent colour.
- **Seeing from the ground:** astronomical refraction lifts and flattens the setting Sun and Moon and raises stars
  near the horizon; stars twinkle more near the horizon; light pollution from the real night-lights map glows over
  cities; airglow at 95 km; aurora around the real geomagnetic pole.
- **Seasons and ages:** Earth's snow cover follows the date (continental interiors first, forests show through the
  snow); ice sheets and sea level follow the Milankovitch cycles; the continents drift with the plates.
- **Orbit mode (Y):** Newtonian two-body flight with thrusters; a 400 km orbit around Earth takes 92.4 minutes.
- **Lighting:** eclipses with penumbra, ring shadows, terrain self-shadowing and baked ambient occlusion, planetshine
  (earthshine on the Moon, moonlight at night), Lommel-Seeliger scattering on airless bodies.
- **Exotic objects:** ray traced black holes (Kerr geodesics in Kerr-Schild coordinates for spinning holes: the
  shadow of a spin-0.94 hole is D-shaped and shifted, matching Bardeen's critical curve to a pixel) with Doppler-beamed accretion disks that end at the spin-dependent innermost stable orbit, volumetric nebulae,
  coronae, ray marched comets (coma, curved dust tail, straight ion tail, sized by distance from the Sun), pulsar beams.
- **Camera:** HDR pipeline with centre-weighted auto exposure (switches to the corona during totality, lets a sunlit
  limb blow out to show city lights), bloom, ACES tone mapping and temporal anti-aliasing with sub-pixel jitter.
- **Performance:** shaders compile in parallel behind a loading screen; terrain tiles bake ambient occlusion once; atmosphere and clouds render at half
  resolution with temporal accumulation when they fill the screen; exposure and ground height readbacks are
  asynchronous; the galaxy sky cube rebuilds in strips; dynamic resolution aims for 55+ fps, then trims ray march
  steps and terrain detail if that is not enough.

**Interface:** search (planets, moons, named stars, nebulae, galaxies), Places and Explore menus, guided tour (T),
eclipse finder (Shift+E), orbit mode (Y), saved views (B), system browser, date picker, shareable location links,
latitude/longitude and local solar time, illuminated fraction and moon phase, GPU timing overlay (F3), settings saved
between visits.

## Layout

    index.html
    src/main.js        entry point, quality settings, test hooks
    src/assets.js      map and catalogue loading
    src/ephem.js       planetary, lunar and Galilean ephemerides, IAU rotation
    src/realsystems.js observed exoplanet systems
    src/tour.js        guided tour
    data/              real data (see data/README.md for sources and licences)
    src/nav.js         camera, world state, go-to, picking, level transitions
    src/render.js      frame pipeline and post processing
    src/planet.js      tile quadtree and surface shading
    src/terrain_glsl.js  surface generators (rocky, gas giant, star)
    src/atmosphere.js, src/atmo_glsl.js  scattering and clouds
    src/sky.js         galaxies, galaxy sky cubemap, star points
    src/starfield.js, src/stars.js   star generation and stellar physics
    src/system.js      Solar System data, procedural systems, orbits
    src/universe.js    galaxy catalogue and galaxy light model
    src/extras.js      rings, orbit lines, asteroid belts
    src/exotic.js      black holes, coronae, nebulae
    src/ui.js, src/ui.css  interface
    tools/shot.mjs     headless screenshot harness (puppeteer-core + SwiftShader)
    tools/data/        scripts that rebuild data/ from the original sources

## Testing

    cd tools && npm i
    ./s.sh earth "" 800 450            # screenshot into ../shots/earth.png
    ./s.sh mars "nav.goTo(c.findByName(nav,'Mars'),{dur:0.01});"

The harness runs frames until tile baking and exposure have settled, then saves a PNG.

    node tools/physicstest.mjs        # 55 checks of the physics against published values (no browser needed)
    node tools/eventtest.mjs          # visits every timeline event and sandbox scenario, screenshots each
    node tools/monkey.mjs 60 7        # random flying, time jumps, sandbox scenarios and keys; reports errors
    node tools/glcheck.mjs            # checks every WebGL draw call for errors across events and scenarios
    node tools/lapsetest.mjs          # fast-forward at a planet: the Sun must hold still from frame to frame

The physics checks cover: a GW150914-like merger (final mass 61.9 M☉, spin 0.68, 3.1 M☉ radiated, ringdown
275 Hz vs LIGO's 62 M☉, 0.67, 3.0 M☉), aligned spins (remnant spin 0.94, 9% radiated, later merger), the recoil of a q = 1/8 merger, orbital decay against the Peters formula
(within 3%), periastron precession against 6πGM/c²a(1−e²), energy conservation over 100 orbits, the
figure-eight choreography, tidal disruption (half the debris bound, first fallback at the theoretical t_min of
41 days), Barnard's Star and Gliese 710 encounters, the Sun's galactic orbit, the solar track (RGB tip 2,730 L☉,
256 R☉, 0.668 M☉; white dwarf 0.54 M☉), lunar recession (3.82 cm/yr), the lengthening day, Vega as pole star,
ΛCDM numbers (CMB 2.7255 K, event horizon 5.1 Gpc), the Andromeda orbit against van der Marel et al. 2012, the
secular frequencies of the planets (g3 17.38"/yr vs 17.33, s3 −18.75 vs −18.74), Earth's eccentricity range,
summer insolation at 65° N (478 W/m² today, 533 W/m² 11,000 years ago), the timing of the Last Glacial Maximum
and deglaciation, the Moon-forming impact (9.9 km/s, a 0.64 lunar mass Moon) and a Type Ia supernova (peak −19.1).

## Decisions and limits

- Raw WebGL2 was chosen over WebGPU so it runs everywhere and can be tested headless here.
- This machine has no GPU. Everything was checked with SwiftShader at reduced settings, so frame rate on real GPUs
  (including the M5) is untested. Press F3 in the app to see GPU time per pass. If it is slow, use `?q=low`;
  dynamic resolution also lowers the render scale below 48 fps.
- Brightness is physical, so a sunlit planet hides the stars and deep space needs long exposures. Auto exposure
  handles this; `[` and `]` bias it. Galaxy and nebula surface brightness is boosted about 20 times to be visible (nebulae return to
  their real brightness when seen from far away, so the Orion Nebula is a faint smudge from Earth).
- Asteroid and dwarf planet orbits beyond the main planets use approximate elements, so their positions along the
  orbit are not exact.
- Galactic dynamics: flat-ish rotation curve (223 km/s, 1.5 kpc core), spiral pattern speed 25 km/s/kpc, the Sun's
  peculiar velocity from Schönrich et al. 2010. Procedural stars stream through their cells and wrap around (a
  statistical model: the density stays right, individual stars are not followed for billions of years).
- Supernova dates for Betelgeuse (100,000 yr) and Antares (600,000 yr) are estimates; their real dates are unknown.
  Procedural massive stars use lifetimes from 4 to 35 Myr by luminosity class.
- Sandbox: post-Newtonian terms act between compact objects only; black hole spins are kept aligned with the orbit (1.5PN spin-orbit
  coupling, no precession);
  the merger is handed to numerical relativity fits at 5.5 GM/c²; the merger-ringdown waveform is a smooth
  phenomenological join to the quasi-normal mode. Tidal debris is Newtonian test particles; returning debris is
  counted as accreted at pericentre (stream collisions and disk formation are not simulated). The giant impact's
  debris disk is set up from published simulation outcomes rather than computed with hydrodynamics.
- Andromeda: the tangential velocity is uncertain (Gaia-era estimates even allow a ~50% chance of no merger within
  10 Gyr, Sawala et al. 2025); 30 km/s was chosen to follow van der Marel et al. 2012. The N-body is restricted
  (particles feel both galaxies' analytic potentials, not each other), with no gas.
- Evolution: Earth's climate thresholds (oceans gone at ~10% more sunlight) are simplified. Continents move rigidly
  with today's plate velocities (no subduction, mountain building or plate reorganisation; held after 100 Myr).
  Ice sheets are colour on the surface (their 3 km thickness is not added to the terrain).
- Relativistic flight (M) transforms the sky (stars, galaxies, the Milky Way); nearby planets are not aberrated, and
  go-to remains a faster-than-light jump.

## Known gaps

- Real elevation is ~10 km per pixel, so features like the Grand Canyon are not resolved; detail below that is procedural.
- Terrain shadows reach two tile levels out, so the very longest shadows at sunrise can still end abruptly.
- Trees are camera-facing billboards (conifers and broadleaf); there are no rocks, buildings or grass meshes.
- Earth's cloud cover is a single observed snapshot: individual cloud cells drift and change with the wind, but the
  weather systems themselves stay where the map put them.
- Aurora seen from orbit is streaky; from the ground it looks right.
- Eclipse timing and paths are good to tens of kilometres and about a minute (no nutation, truncated lunar series).
- Galaxies other than the Milky Way and nebulae other than the six named ones are procedural.
- A pair of black holes is ray traced through the sum of their Schwarzschild bendings (each hole static during a
  ray's flight), not a full binary spacetime. Light bent out of the rendered frame picks up the model galaxy sky,
  not the photographed Milky Way or individual stars.
- The galaxy collision has no dust lanes or new star clusters (star formation is a brightness boost of young stars).
- Earth's clouds are today's: after millions of years of drift they no longer match the continents beneath.
- Sandbox planets share one rocky surface look; the Moon-forming debris disk is a fit to published simulations, not
  hydrodynamics, and the new Moon does not recede tidally in the sandbox.
- Exposure is metered on the brightest part of the frame, so a bright Moon or supernova in view darkens the stars.
