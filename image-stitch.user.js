// ==UserScript==
// @name         X Image Stitch
// @version      1.0
// @description  Stitch split X post images into one seamless image.
// @license      MIT
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM.xmlHttpRequest
// @connect      pbs.twimg.com
// @connect      ton.twimg.com
// ==/UserScript==

(() => {
    'use strict';

    function matchSeam(left, right, height, gap, enhanced = false) {
        const penalty = enhanced ? 100 : 50;
        const describe = data => {
            const out = new Uint8Array(height * 12);
            for (let y = 0; y < height; y++) {
                const low = Math.max(0, y - 1) * 4;
                const high = Math.min(height - 1, y + 1) * 4;
                for (let c = 0; c < 3; c++) {
                    const p = y * 12 + c * 4;
                    out[p] = data[low + c];
                    out[p + 1] = data[y * 4 + c];
                    out[p + 2] = data[high + c];
                    out[p + 3] = Math.abs(data[high + c] - data[low + c]);
                }
            }
            return out;
        };
        const leftFeatures = enhanced ? describe(left) : null;
        const rightFeatures = enhanced ? describe(right) : null;
        const radius = Math.min(height - 1, Math.max(8, gap * 2));
        const stride = radius * 2 + 1;
        const steps = new Uint8Array(height * stride);
        let previous = new Float64Array(stride).fill(Infinity);
        let current = new Float64Array(stride);

        for (let y = 0; y < height; y++) {
            current.fill(Infinity);
            for (let d = -radius; d <= radius; d++) {
                const row = y + d;
                if (row < 0 || row >= height) continue;
                const k = d + radius;
                let cost = d * d * 0.1;

                if (enhanced) {
                    for (let c = 0; c < 3; c++) {
                        const p = y * 12 + c * 4, q = row * 12 + c * 4;
                        cost += (leftFeatures[p] - rightFeatures[q]) ** 2 / 9;
                        cost += (leftFeatures[p + 1] - rightFeatures[q + 1]) ** 2 / 9;
                        cost += (leftFeatures[p + 2] - rightFeatures[q + 2]) ** 2 / 9;
                        cost += (leftFeatures[p + 3] - rightFeatures[q + 3]) ** 2 / 12;
                    }
                } else {
                    for (let c = 0; c < 3; c++) {
                        cost += (left[y * 4 + c] - right[row * 4 + c]) ** 2 / 3;
                    }
                }

                let best = previous[k], step = 0;
                if (k + 1 < stride && previous[k + 1] + penalty < best) {
                    best = previous[k + 1] + penalty;
                    step = 1;
                }
                if (k > 0 && current[k - 1] + penalty < best) {
                    best = current[k - 1] + penalty;
                    step = 2;
                }
                if (y === 0 && row === 0) best = 0;
                current[k] = cost + best;
                steps[y * stride + k] = step;
            }
            [previous, current] = [current, previous];
        }

        const pairs = [];
        let a = height - 1, b = height - 1;
        while (a >= 0 && b >= 0) {
            pairs.push([a, b]);
            const step = steps[a * stride + b - a + radius];
            if (step !== 2) a--;
            if (step !== 1) b--;
        }
        pairs.reverse();
        return pairs;
    }

    function fillSeam(left, right, height, gap) {
        const pairs = matchSeam(left, right, height, gap, true);
        const pixels = new Uint8ClampedArray(gap * height * 4);
        const sample = (data, row, c) => {
            const y = Math.max(0, Math.min(height - 1, row));
            const low = Math.floor(y), high = Math.min(height - 1, low + 1);
            const t = y - low;
            return data[low * 4 + c] * (1 - t) + data[high * 4 + c] * t;
        };

        for (let x = 0; x < gap; x++) {
            const t = (x + 1) / (gap + 1);
            let p = 0;
            for (let y = 0; y < height; y++) {
                while (p + 1 < pairs.length - 1 &&
                       pairs[p + 1][0] * (1 - t) + pairs[p + 1][1] * t < y) p++;
                const [a0, b0] = pairs[p];
                const [a1, b1] = pairs[Math.min(p + 1, pairs.length - 1)];
                const start = a0 * (1 - t) + b0 * t;
                const end = a1 * (1 - t) + b1 * t;
                const f = end === start ? 0
                    : Math.max(0, Math.min(1, (y - start) / (end - start)));
                for (let c = 0; c < 4; c++) {
                    pixels[(y * gap + x) * 4 + c] =
                        sample(left, a0 + (a1 - a0) * f, c) * (1 - t) +
                        sample(right, b0 + (b1 - b0) * f, c) * t;
                }
            }
        }
        return pixels;
    }

    // Copy a nearby patch only when its RGB texture matches BOTH known sides.
    // Reads are restricted to original tiles; only the synthesized gap is changed.
    function textureSeam(pixels, left, right, width, height, gap) {
        if (gap < 2 || gap > 32 || width < gap + 12 || height < 16) return pixels;
        const at = (data, x, y, c) => data[(y * width + x) * 4 + c];
        const sums = new Float32Array(pixels.length), weights = new Float32Array(height);
        const border = 4, block = 12;
        for (let y = 0; y <= height - block; y += 6) {
            let energy = 0;
            for (const data of [left, right]) {
                const start = data === left ? width - border : 0;
                for (let r = 1; r < block; r++) for (let x = 0; x < border; x++)
                    for (let c = 0; c < 3; c++)
                        energy += (at(data, start + x, y + r, c) -
                                   at(data, start + x, y + r - 1, c)) ** 2;
            }
            energy /= 2 * (block - 1) * border * 3;
            if (energy < 16) continue; // Flat shading supplies no reliable texture evidence.
            let best = Math.min(900, energy * 2), donor;
            for (const data of [left, right]) {
                for (let dy = -24; dy <= 24; dy++) {
                    const row = y + dy;
                    if (row < 0 || row + block > height) continue;
                    for (let sx = border; sx <= width - gap - border; sx++) {
                        let error = 0;
                        for (let r = 0; r < block; r += 2) {
                            for (let b = 0; b < border; b++) for (let c = 0; c < 3; c++) {
                                error += (at(left, width - border + b, y + r, c) -
                                          at(data, sx - border + b, row + r, c)) ** 2;
                                error += (at(right, b, y + r, c) -
                                          at(data, sx + gap + b, row + r, c)) ** 2;
                            }
                        }
                        error /= block * border * 3;
                        if (error < best) { best = error; donor = { data, sx, row }; }
                    }
                }
            }
            if (!donor) continue;
            // Validate every row, including those excluded from the search score.
            let error = 0, opaque = true;
            for (let r = 0; r < block; r++) {
                for (let b = 0; b < border; b++) for (let c = 0; c < 3; c++) {
                    error += (at(left, width - border + b, y + r, c) -
                              at(donor.data, donor.sx - border + b, donor.row + r, c)) ** 2;
                    error += (at(right, b, y + r, c) -
                              at(donor.data, donor.sx + gap + b, donor.row + r, c)) ** 2;
                }
                for (let x = -border; x < gap + border; x++)
                    opaque &&= at(donor.data, donor.sx + x, donor.row + r, 3) === 255;
                for (let b = 0; b < border; b++)
                    opaque &&= at(left, width - border + b, y + r, 3) === 255 &&
                               at(right, b, y + r, 3) === 255;
            }
            const confidence = 1 - error / (2 * block * border * 3) / Math.min(900, energy * 2);
            if (!opaque || confidence <= 0) continue;
            for (let r = 0; r < block; r++) {
                const weight = Math.min(r + 1, block - r, 3) / 3 * confidence;
                weights[y + r] += weight;
                for (let x = 0; x < gap; x++) for (let c = 0; c < 3; c++)
                    sums[((y + r) * gap + x) * 4 + c] +=
                        weight * at(donor.data, donor.sx + x, donor.row + r, c);
            }
        }
        // Preserve contours carried by the interpolation. Averaging across
        // columns and comparing two-row means suppresses fine texture.
        const contour = new Float32Array(height);
        for (let y = 2; y < height - 1; y++) {
            let strength = 0;
            for (let c = 0; c < 3; c++) {
                let difference = 0;
                for (let x = 0; x < gap; x++) {
                    const p = (y * gap + x) * 4 + c;
                    const stride = gap * 4;
                    difference += pixels[p] + pixels[p + stride] -
                                  pixels[p - stride] - pixels[p - 2 * stride];
                }
                strength = Math.max(strength, Math.abs(difference) / (2 * gap));
            }
            contour[y] = Math.max(0, Math.min(1, (strength - 18) / 32));
        }
        for (let y = 0; y < height; y++) if (weights[y]) {
            const protection = Math.max(contour[y], 0.5 * (contour[y - 1] || 0),
                                        0.5 * (contour[y + 1] || 0));
            const blend = Math.min(1, weights[y]) * (1 - protection);
            for (let x = 0; x < gap; x++) for (let c = 0; c < 3; c++) {
                const p = (y * gap + x) * 4 + c;
                pixels[p] = pixels[p] * (1 - blend) + sums[p] / weights[y] * blend;
            }
        }
        return pixels;
    }

    const iw = img => img.naturalWidth || img.width;
    const ih = img => img.naturalHeight || img.height;
    const seamCuts = new WeakMap();
    const whiteEdges = new WeakMap();

    function seamBand(img, right, max = 12, confidence = 0.9) {
        const w = iw(img), h = ih(img);
        if (w < max + 4) return 0;
        const span = max + 3;
        const canvas = document.createElement('canvas');
        canvas.width = span;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, right ? w - span : 0, 0, span, h, 0, 0, span, h);
        const data = ctx.getImageData(0, 0, span, h).data;
        const step = Math.max(1, Math.ceil(h / 256));
        const at = (x, y) => (y * span + (right ? span - 1 - x : x)) * 4;
        const diffs = Array.from({ length: span - 1 }, (_, x) => {
            const rows = [];
            for (let y = 0; y < h; y += step) {
                const a = at(x, y), b = at(x + 1, y);
                let error = 0;
                for (let c = 0; c < 3; c++) error += Math.abs(data[a + c] - data[b + c]);
                rows.push(error);
            }
            return rows;
        });
        const means = diffs.map(rows => rows.reduce((sum, d) => sum + d, 0) / (rows.length * 3));
        let band = 0;
        for (let b = 1; b <= max; b++) {
            const jump = means[b - 1];
            const inner = (means[b] + means[b + 1]) / 2;
            let outer = 0;
            for (let i = 0; i < b - 1; i++) outer += means[i];
            if (b > 1) outer /= b - 1;
            if (!(jump > 12 && jump > inner * 2.5 && jump > outer * 1.5)) continue;
            const hits = diffs[b - 1].filter((edge, y) =>
                edge > 36 && edge > (diffs[b][y] + diffs[b + 1][y]) * 1.25).length;
            if (hits >= diffs[b - 1].length * confidence) band = b;
        }
        const fading = x => {
            let hits = 0, rows = 0;
            for (let y = 0; y < h; y += step) {
                const a = at(x, y), b = at(x + 1, y);
                if ([0, 1, 2].every(c => data[a + c] - data[b + c] > 6)) hits++;
                rows++;
            }
            return hits / rows;
        };
        if (fading(0) >= 0.9) {
            const edges = whiteEdges.get(img) || {};
            edges[right ? 'right' : 'left'] = true;
            whiteEdges.set(img, edges);
            for (let b = 1; b <= max; b++) {
                const jump = means[b - 1];
                if (jump <= 12 || fading(b - 1) < 0.6) break;
                if (jump > (means[b] + means[b + 1]) * 1.25) {
                    band = Math.max(band, b);
                }
            }
        }
        return band;
    }

    function cleanFringe(img, { left, right, white: edges }) {
        const width = iw(img), height = ih(img);
        if (!edges || (!edges.left && !edges.right) || width < 26) return img;
        let output, outputCtx;
        for (const side of ['left', 'right']) {
            if (!edges[side] || !(side === 'left' ? left : right)) continue;
            const strip = document.createElement('canvas');
            strip.width = 13;
            strip.height = height;
            const ctx = strip.getContext('2d');
            const start = side === 'right' ? width - 13 : 0;
            ctx.drawImage(img, start, 0, 13, height, 0, 0, 13, height);
            const pixels = ctx.getImageData(0, 0, 13, height);
            const source = pixels.data;
            const at = (x, y) => (y * 13 + (side === 'right' ? 12 - x : x)) * 4;
            let changed = false;
            for (let x = 0; x < 4; x++) {
                const errors = [[], [], []];
                let positive = 0, rows = 0;
                for (let y = 0; y < height; y += Math.max(1, Math.ceil(height / 256))) {
                    let sum = 0;
                    for (let c = 0; c < 3; c++) {
                        const a = source[at(8, y) + c], b = source[at(12, y) + c];
                        const expected = Math.max(0, Math.min(255, a + (b - a) * (x - 8) / 4));
                        const error = source[at(x, y) + c] - expected;
                        errors[c].push(error);
                        sum += error;
                    }
                    if (sum > 0) positive++;
                    rows++;
                }
                const offsets = errors.map(values => {
                    values.sort((a, b) => a - b);
                    return values[values.length >> 1];
                });
                if (rows < 32 || positive < rows * 0.6 ||
                    offsets.reduce((a, b) => a + b, 0) < 3 ||
                    offsets.some(v => Math.abs(v) > 24)) continue;
                for (let y = 0; y < height; y++) {
                    const p = at(x, y);
                    if (offsets.some((v, c) => source[p + c] - v < 0 || source[p + c] - v > 255)) continue;
                    for (let c = 0; c < 3; c++) {
                        const before = source[p + c];
                        pixels.data[p + c] = before - offsets[c];
                        if (pixels.data[p + c] !== before) changed = true;
                    }
                }
            }
            if (!changed) continue;
            if (!output) {
                output = document.createElement('canvas');
                output.width = width;
                output.height = height;
                outputCtx = output.getContext('2d');
                outputCtx.drawImage(img, 0, 0, width, height, 0, 0, width, height);
            }
            outputCtx.putImageData(pixels, start, 0);
        }
        return output || img;
    }
    async function cutSeamBands(images) {
        const cuts = images.map((img, i) => ({
            left: i > 0 ? seamBand(img, false) : 0,
            right: i < images.length - 1 ? seamBand(img, true) : 0,

        }));
        for (let i = 0; i < images.length - 1; i++) {
            const a = cuts[i], b = cuts[i + 1];
            if (!a.right && b.left) {
                a.right = seamBand(images[i], true, 12, 0.8);
            } else if (a.right && !b.left) {
                b.left = seamBand(images[i + 1], false, 12, 0.8);
            }
        }
        cuts.forEach((cut, i) => { cut.white = whiteEdges.get(images[i]); });
        if (cuts.every(c => !c.left && !c.right)) return images;
        const settled = await Promise.allSettled(images.map(async (img, i) => {
            const { left, right } = cuts[i];
            if (!left && !right) return img;
            const sw = iw(img) - left - right;
            if (sw < 5) return img;
            const cropped = left || right
                ? await createImageBitmap(img, left, 0, sw, ih(img)) : img;
            try {
                const cleaned = cleanFringe(cropped, cuts[i]);
                if (cleaned === cropped) return cropped;
                const result = await createImageBitmap(cleaned);
                if (cropped !== img) cropped.close();
                return result;
            } catch (error) {
                if (cropped !== img) cropped.close();
                throw error;
            }
        }));
        const failed = settled.find(item => item.status === 'rejected');
        settled.forEach((item, i) => {
            if (item.status === 'fulfilled' && item.value !== images[i]) {
                if (!failed) seamCuts.set(item.value, cuts[i]);
                (failed ? item.value : images[i]).close();
            }
        });
        if (failed) throw failed.reason;
        return settled.map(item => item.value);
    }

    function findOverlap(left, right, width, height) {
        let best = Infinity, second = Infinity, overlap = 0;
        const yStep = Math.max(1, Math.ceil(height / 512));
        for (let w = 1; w <= width; w++) {
            let error = 0, count = 0;
            const xStep = Math.max(1, Math.floor(w / 8));
            for (let y = 0; y < height; y += yStep) {
                for (let x = 0; x < w; x += xStep) {
                    const a = (y * width + width - w + x) * 4;
                    const b = (y * width + x) * 4;
                    error += Math.abs(left[a] - right[b])
                        + Math.abs(left[a + 1] - right[b + 1])
                        + Math.abs(left[a + 2] - right[b + 2]);
                    count += 3;
                }
            }
            if ((error /= count) < best) {
                second = best;
                best = error;
                overlap = w;
            } else second = Math.min(second, error);
        }
        return overlap >= 2 && best < 4 && best < second * 0.75 ? overlap : 0;
    }

    function estimateGaps(images, maxes) {
        const n = images.length - 1;
        const zeros = () => Array(n).fill(0);
        const height = ih(images[0]);
        const overlap = 64;
        if (!n || !height || images.some(img => iw(img) < 5 || ih(img) !== height)) {
            return zeros();
        }

        const canvas = document.createElement('canvas');
        canvas.width = 5;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const strip = (img, right, width = 5) => {
            canvas.width = width;
            ctx.drawImage(img, right ? iw(img) - width : 0, 0,
                width, height, 0, 0, width, height);
            return ctx.getImageData(0, 0, width, height).data;
        };

        const gaps = [];
        for (let i = 0; i < n; i++) {
            const bound = maxes[i]
                || seamCuts.get(images[i])?.right
                || seamCuts.get(images[i + 1])?.left
                || 0;
            const hi = bound ? Math.max(128, bound) : 0;
            const width = Math.min(overlap, iw(images[i]) - 1, iw(images[i + 1]) - 1);
            const repeated = findOverlap(strip(images[i], true, width),
                strip(images[i + 1], false, width), width, height);

            if (repeated) {
                gaps.push(-repeated);
                continue;
            }
            if (!hi) {
                gaps.push(0);
                continue;
            }

            const values = [];
            const a = strip(images[i], true);
            const b = strip(images[i + 1], false);
            const left = a.filter((_, i) => (i >> 2) % 5 === 4);
            const right = b.filter((_, i) => (i >> 2) % 5 === 0);

            for (const [y, z] of matchSeam(left, right, height, hi)) {
                if (Math.min(y, z) < 2 || Math.max(y, z) >= height - 2) continue;
                let lx = 0, ly = 0, rx = 0, ry = 0, agree = 0;
                for (let c = 0; c < 3; c++) {
                    const u = (left[(y + 2) * 4 + c] - left[(y - 2) * 4 + c]) / 4;
                    const v = (right[(z + 2) * 4 + c] - right[(z - 2) * 4 + c]) / 4;
                    lx -= u * (left[y * 4 + c] - a[y * 20 + 8 + c]) / 2;
                    rx -= v * (b[z * 20 + 8 + c] - right[z * 4 + c]) / 2;
                    ly += u * u;
                    ry += v * v;
                    agree += u * v;
                }
                if (ly <= 100 || ry <= 100) continue;
                const sl = lx / ly, sr = rx / ry, slope = (sl + sr) / 2;
                if (!(agree > .8 * Math.sqrt(ly * ry) &&
                    Math.abs(slope) > .15 && sl * sr > 0 &&
                    Math.abs(sl - sr) < .8 * Math.abs(slope))) continue;

                const gap = (z - y) / slope - 1;
                if (gap >= -1 && gap <= hi) values.push(gap);
            }

            values.sort((a, b) => a - b);
            gaps.push(values.length < 8 ? 0
                : Math.max(0, Math.min(hi, Math.round(values[values.length >> 1]))));
        }
        return gaps;
    }

    // Decode via ImageBitmap so getImageData/putImageData stay allowed in Firefox.
    const loadImage = src => new Promise((resolve, reject) => {
        const fail = () => reject(new Error('Stitch load failed'));
        GM.xmlHttpRequest({
            method: 'GET', url: src, responseType: 'blob',
            onload: r => {
                if (r.status < 200 || r.status >= 300) return fail();
                const type = r.response.type || 'image/jpeg';
                createImageBitmap(r.response).then(
                    bitmap => resolve({ bitmap, type }), fail);
            },
            onerror: fail, ontimeout: fail,
        });
    });

    async function loadOrigBitmaps(shots) {
        const loaded = await Promise.allSettled(shots.map(async img => {
            const url = new URL(img.src);
            url.searchParams.set('name', 'orig');
            return loadImage(url.href);
        }));
        const items = loaded
            .filter(item => item.status === 'fulfilled')
            .map(item => item.value);
        const images = items.map(item => item.bitmap);
        const failed = loaded.find(item => item.status === 'rejected');
        if (failed) {
            for (const img of images) img.close();
            throw failed.reason;
        }
        return { images, type: items[0].type };
    }

    function layoutGaps(shots, images) {
        const rects = shots.map(img => img.getBoundingClientRect());
        const gaps = [];
        for (let i = 0; i < rects.length - 1; i++) {
            const a = rects[i], b = rects[i + 1];
            if (!a.width || !a.height || Math.abs(a.top - b.top) > 1) {
                gaps.push(null);
                continue;
            }
            const scale = Math.min(iw(images[i]) / a.width, ih(images[i]) / a.height);
            gaps.push(Math.max(0, Math.ceil((b.left - a.right) * scale)));
        }
        const fallback = Math.max(0, ...gaps.filter(g => g != null));
        return gaps.map(g => g ?? fallback);
    }

    function stitch(images, gaps, type = 'image/jpeg') {
        const mime = /^image\/(jpeg|png|webp)$/.test(type) ? type : 'image/jpeg';
        const encode = canvas => mime === 'image/jpeg'
            ? canvas.toDataURL(mime, 0.95)
            : canvas.toDataURL(mime);
        const height = Math.max(...images.map(ih));
        let gs = gaps.map(g => g | 0);
        if (gs.some(Boolean) && images.some(img => ih(img) !== height)) {
            gs = gs.map(() => 0);
        }

        const paint = list => {
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, images.reduce((s, img) => s + iw(img), 0)
                + list.reduce((s, g) => s + g, 0));
            canvas.height = height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const seams = [];
            let x = 0;
            images.forEach((img, i) => {
                const trim = Math.max(0, -(list[i - 1] || 0));
                ctx.drawImage(img, trim, 0, iw(img) - trim, ih(img),
                    x + trim, 0, iw(img) - trim, ih(img));
                x += iw(img);
                if (i < images.length - 1) {
                    seams.push({ x, gap: list[i] });
                    x += list[i];
                }
            });
            return { canvas, ctx, seams };
        };

        const { canvas, ctx, seams } = paint(gs);
        if (gs.some(g => g > 0)) {
            try {
                for (const [i, { x, gap }] of seams.entries()) {
                    if (gap <= 0) continue;
                    const left = ctx.getImageData(x - 1, 0, 1, height).data;
                    const right = ctx.getImageData(x + gap, 0, 1, height).data;
                    // Keep ImageData in the page realm for Firefox.
                    const fill = ctx.createImageData(gap, height);
                    fill.data.set(fillSeam(left, right, height, gap));
                    const width = Math.min(96, iw(images[i]) - Math.max(0, -(gs[i - 1] || 0)),
                        iw(images[i + 1]) - Math.max(0, -(gs[i + 1] || 0)));
                    if (gap >= 2 && gap <= 32 && width >= gap + 12 && height >= 16) {
                        textureSeam(fill.data, ctx.getImageData(x - width, 0, width, height).data,
                            ctx.getImageData(x + gap, 0, width, height).data, width, height, gap);
                    }
                    ctx.putImageData(fill, x, 0);
                }
            } catch (error) {
                console.error('[xis]', error);
                if (/security/i.test(error?.name + error?.message)) {
                    return encode(paint(gs.map(() => 0)).canvas);
                }
                throw error;
            }
        }
        return encode(canvas);
    }

    function photoGroups(tweet) {
        const groups = new Map();
        for (const link of tweet.querySelectorAll('a[href*="/photo/"]')) {
            const match = link.href.match(/\/status\/(\d+)\/photo\/(\d+)/);
            const img = link.querySelector('img');
            if (!match || !img) continue;
            const [, id, index] = match;
            let photos = groups.get(id);
            if (!photos) groups.set(id, photos = new Map());
            photos.set(+index, img);
        }
        for (const [id, photos] of groups) {
            groups.set(id, [...photos].sort((a, b) => a[0] - b[0]).map(([, img]) => img));
        }
        return groups;
    }

    function mediaBox(tweet, host) {
        let el = host;
        while (el.parentElement && tweet.contains(el.parentElement)) {
            const parent = el.parentElement;
            if (parent.querySelector('[data-testid="User-Name"], [data-testid="reply"]')) break;
            el = parent;
            const s = getComputedStyle(el);
            if (parseFloat(s.paddingBottom) > 0 || (s.aspectRatio && s.aspectRatio !== 'auto')) break;
        }
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        return el;
    }

    function showResult(href, { tweet, shots, id }) {
        const image = new Image();
        image.alt = 'Stitched';
        image.src = href;
        const link = Object.assign(document.createElement('a'), {
            href, target: '_blank', rel: 'noopener',
        });
        link.append(image);
        link.onclick = e => e.stopPropagation();

        const wrap = Object.assign(document.createElement('div'), {
            className: 'xis-host',
        });
        wrap.dataset.xis = id;
        wrap.append(link);
        if (!tweet.isConnected || shots.some(img => !tweet.contains(img))) {
            throw new Error('Stitch photos missing');
        }
        const frames = shots.map(img => img.closest('[data-testid="tweetPhoto"]') || img);
        let host = frames[0];
        while (host && !frames.every(img => host.contains(img))) host = host.parentElement;
        if (!host || host === tweet || !tweet.contains(host)) {
            throw new Error('Stitch photos missing');
        }

        const target = mediaBox(tweet, host);
        target.replaceWith(wrap);
    }

    function addStitchButtons() {
        for (const tweet of document.querySelectorAll('article[data-testid="tweet"]')) {
            if (!tweet.querySelector('[data-testid="reply"]')?.closest('[role="group"]')) continue;

            for (const [id, previews] of photoGroups(tweet)) {
                if (previews.length < 2) continue;
                if (previews.every(img => img.naturalHeight > 0)) {
                    const hs = previews.map(img => img.naturalHeight);
                    if (Math.max(...hs) - Math.min(...hs) > 1) continue;
                }
                const frames = previews.map(img => img.closest('[data-testid="tweetPhoto"]') || img);

                let host = frames[0];
                while (host && !frames.every(f => host.contains(f))) host = host.parentElement;
                if (!host || tweet.querySelector(`.xis-button[data-xis="${id}"], .xis-host[data-xis="${id}"]`)) {
                    continue;
                }

                const media = mediaBox(tweet, host);
                media.classList.add('xis-media');

                const layer = document.createElement('div');
                layer.className = 'xis-layer';
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'xis-button';
                button.dataset.xis = id;
                button.textContent = 'Stitch images';
                button.title = 'Stitch images';
                button.setAttribute('aria-label', 'Stitch images');
                layer.append(button);
                media.append(layer);

                button.onclick = async event => {
                    event.stopPropagation();
                    button.disabled = true;
                    button.classList.add('xis-busy');
                    button.setAttribute('aria-busy', 'true');
                    let images = [];
                    try {
                        const shots = photoGroups(tweet).get(id) || [];
                        if (shots.length < 2) throw new Error('Stitch photos missing');

                        const loaded = await loadOrigBitmaps(shots);
                        images = loaded.images;
                        images = await cutSeamBands(images);
                        if (!tweet.isConnected || shots.some(img => !tweet.contains(img))) {
                            throw new Error('Stitch photos missing');
                        }
                        const href = stitch(
                            images,
                            estimateGaps(images, layoutGaps(shots, images)),
                            loaded.type,
                        );
                        showResult(href, { tweet, shots, id });
                    } catch (error) {
                        console.error('[xis]', error);
                        button.classList.remove('xis-busy');
                        button.removeAttribute('aria-busy');
                        button.disabled = false;
                    } finally {
                        for (const img of images) img.close?.();
                    }
                };
            }
        }
    }

    function start() {
        if (!document.head || !document.body) {
            document.addEventListener('DOMContentLoaded', start, { once: true });
            return;
        }
        document.head.append(Object.assign(document.createElement('style'), {
            textContent: `
                .xis-host>a{display:block}
                .xis-host>a img{display:block;max-width:100%;height:auto;border-radius:12px}
                .xis-layer{position:absolute;inset:0;z-index:10000;pointer-events:none}
                .xis-button{position:absolute;top:8px;left:8px;border:0;border-radius:8px;padding:3px 9px;background:rgba(15,20,25,.75);color:#fff;font:700 13px system-ui;cursor:pointer;opacity:0;pointer-events:none;transition:background-color .2s}
                .xis-button:hover{background:rgba(39,44,48,.75)}
                .xis-button:active{background:rgba(63,67,71,.75)}
                .xis-button.xis-busy{opacity:1;pointer-events:none;overflow:hidden}
                .xis-button.xis-busy::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,#fff5,transparent);transform:translateX(-100%);animation:xis-shimmer 1.15s cubic-bezier(.4,0,.2,1) infinite}
                @keyframes xis-shimmer{to{transform:translateX(100%)}}
                .xis-layer:hover>.xis-button,.xis-media:hover>.xis-layer>.xis-button{opacity:1;pointer-events:auto}
            `,
        }));
        let timer;
        new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(addStitchButtons, 300);
        }).observe(document.body, { childList: true, subtree: true });
        addStitchButtons();
    }

    start();
})();