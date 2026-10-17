package com.hestari.hestia

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * The system-bar colour the page reports, and the icon contrast that follows.
 *
 * The app lays out edge to edge and pads a container to clear the status and
 * navigation bars, so that container's colour IS the strips. It was fixed at
 * the dark default, which framed a Light or Cream household in two dark bands.
 *
 * The half that is easy to forget is the ICONS. Two of the five themes are
 * near-white; painting the strips to match without flipping the system icons
 * leaves white icons on a white bar and the clock, battery and signal vanish.
 */
class BarColorTest {

    /* The five THEME_META values from dashboard.html, which is the only thing
       that ever calls this. If a sixth theme is added these should grow. */
    private val DARK_THEMES = listOf("#0D0F12", "#1C2028", "#1C1A17")
    private val LIGHT_THEMES = listOf("#F5F5F3", "#F5F0E8")

    @Test
    fun `every shipped theme colour parses`() {
        for (c in DARK_THEMES + LIGHT_THEMES) {
            assertTrue(c, HestiaBridge.parseColor(c) != null)
        }
    }

    @Test
    fun `the parsed value is opaque`() {
        // A translucent bar would show the WebView's own white background
        // through it, which is the framing the container exists to prevent.
        val c = HestiaBridge.parseColor("#F5F0E8")!!
        assertEquals(0xFF, (c ushr 24) and 0xFF)
        assertEquals(0xF5, (c ushr 16) and 0xFF)
        assertEquals(0xF0, (c ushr 8) and 0xFF)
        assertEquals(0xE8, c and 0xFF)
    }

    /* Color.parseColor would THROW on these, turning a settings change into a
       crash. Returning null leaves the bars as they are. */
    @Test
    fun `anything that is not a six-digit hex is refused, not thrown`() {
        for (bad in listOf("", "   ", "red", "#fff", "#ff0000ff", "#12345g",
                           "0xFF0000", "rgb(0,0,0)", "#", "F5F0E8F5F0E8")) {
            assertNull(bad, HestiaBridge.parseColor(bad))
        }
        assertNull(HestiaBridge.parseColor(null))
    }

    @Test
    fun `a leading hash is optional and case does not matter`() {
        assertEquals(HestiaBridge.parseColor("#f5f0e8"), HestiaBridge.parseColor("F5F0E8"))
    }

    /* THE PART THAT MATTERS FOR READABILITY. The decision is made from the
       colour, not from a theme name, so a theme added later needs no change in
       MainActivity. 0.5 is the conventional split; these assertions also show
       nothing ships near the boundary where the choice would be arguable. */
    /* Asserted through needsDarkIcons, which is what MainActivity actually
       calls -- NOT through luminanceOf. The first version tested the predicate
       instead of the doorway, and a mutation making needsDarkIcons return a
       constant survived the whole suite. Same mistake as testing isSafePath
       rather than the request path that uses it, made twice in one day. */
    @Test
    fun `light themes ask for dark icons and dark themes for light ones`() {
        for (c in LIGHT_THEMES) {
            assertTrue("$c (luminance ${HestiaBridge.luminanceOf(HestiaBridge.parseColor(c)!!)})",
                HestiaBridge.needsDarkIcons(HestiaBridge.parseColor(c)!!))
        }
        for (c in DARK_THEMES) {
            assertFalse("$c (luminance ${HestiaBridge.luminanceOf(HestiaBridge.parseColor(c)!!)})",
                HestiaBridge.needsDarkIcons(HestiaBridge.parseColor(c)!!))
        }
    }

    /* White and black are the unambiguous ends; if these ever disagree the
       formula itself is wrong rather than the threshold. */
    @Test
    fun `the extremes are never ambiguous`() {
        assertTrue(HestiaBridge.needsDarkIcons(HestiaBridge.parseColor("#FFFFFF")!!))
        assertFalse(HestiaBridge.needsDarkIcons(HestiaBridge.parseColor("#000000")!!))
    }

    /* THE FIVE SHIPPED THEMES CANNOT TELL THESE FORMULAS APART -- they are all
       near-black or near-white, so a plain average classifies them identically
       and both mutations survived a suite that only tested those. These two
       colours are where the formulas actually disagree, and a sixth theme in
       the mid-tones is exactly the case that would otherwise ship wrong.

       Mid grey reads DARKER than its number suggests: the sRGB transfer curve
       puts #808080 at ~0.22, not ~0.50. Without the curve it would cross the
       threshold and ask for dark icons on a background too dark to carry them. */
    @Test
    fun `mid grey is judged through the transfer curve, not linearly`() {
        val grey = HestiaBridge.parseColor("#808080")!!
        val lum = HestiaBridge.luminanceOf(grey)
        assertTrue("expected ~0.216, got $lum", lum < 0.3)
        assertFalse("mid grey needs LIGHT icons", HestiaBridge.needsDarkIcons(grey))
    }

    /* Green carries most of the perceived brightness (0.7152) and blue almost
       none (0.0722). Weight them equally and pure green drops to a third,
       flipping its icons the wrong way. */
    @Test
    fun `channels are weighted perceptually, not equally`() {
        assertTrue("pure green is bright and needs dark icons",
            HestiaBridge.needsDarkIcons(HestiaBridge.parseColor("#00FF00")!!))
        assertFalse("pure blue is dark and needs light icons",
            HestiaBridge.needsDarkIcons(HestiaBridge.parseColor("#0000FF")!!))
    }

    @Test
    fun `no shipped theme sits near the contrast boundary`() {
        val all = (DARK_THEMES + LIGHT_THEMES)
            .map { HestiaBridge.luminanceOf(HestiaBridge.parseColor(it)!!) }
        assertTrue("closest to 0.5 was ${all.minByOrNull { Math.abs(it - 0.5) }}",
            all.all { Math.abs(it - 0.5) > 0.25 })
    }
}
