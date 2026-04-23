import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { silenceSettings } from "../src/core/config.js";
import { FrameRange } from "../src/core/models.js";
import type { KeepRangesAnalyzer } from "../src/core/xmemlCutter.js";
import {
  parsePosixPathurl,
  processXmemlFile,
  splitClipitemByKeepRanges,
  splitClipitemByTimelineCuts,
} from "../src/core/xmemlCutter.js";
import { DOMParser } from "@xmldom/xmldom";
import { xpathElements } from "../src/core/xmlUtils.js";

function sampleXmeml(mediaPath: string): string {
  const href = pathToFileURL(mediaPath).href;
  return `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="5">
  <sequence>
    <rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>
    <media>
      <audio>
        <track>
          <clipitem id="a1c1">
            <name>Clip1</name>
            <start>0</start><end>90</end>
            <in>0</in><out>90</out>
            <duration>90</duration>
            <file id="f1"><pathurl>${href}</pathurl></file>
          </clipitem>
        </track>
      </audio>
      <video>
        <track>
          <clipitem id="v1c1">
            <name>Video1</name>
            <start>0</start><end>90</end>
            <in>0</in><out>90</out>
            <duration>90</duration>
            <file id="f1"><pathurl>${href}</pathurl></file>
          </clipitem>
        </track>
      </video>
    </media>
  </sequence>
</xmeml>
`;
}

describe("xmeml cutter", () => {
  it("parses posix pathurl", () => {
    expect(parsePosixPathurl("file://localhost/Users/test/a%20b.wav")).toBe("/Users/test/a b.wav");
  });

  it("splits clipitem by keep ranges", () => {
    const doc = new DOMParser().parseFromString(
      "<clipitem id='c1'><start>100</start><end>190</end><in>10</in><out>100</out><duration>90</duration></clipitem>",
      "text/xml",
    );
    const clip = doc.documentElement!;
    const pieces = splitClipitemByKeepRanges(clip, [new FrameRange(0, 20), new FrameRange(40, 60)], 1);
    expect(pieces.length).toBe(2);
    expect(pieces[0]!.getElementsByTagName("start")[0]!.textContent).toBe("100");
    expect(pieces[0]!.getElementsByTagName("end")[0]!.textContent).toBe("120");
    expect(pieces[0]!.getElementsByTagName("in")[0]!.textContent).toBe("10");
    expect(pieces[0]!.getElementsByTagName("out")[0]!.textContent).toBe("30");
    expect(pieces[1]!.getElementsByTagName("start")[0]!.textContent).toBe("140");
    expect(pieces[1]!.getElementsByTagName("end")[0]!.textContent).toBe("160");
  });

  it("splits clipitem by absolute timeline cut frames", () => {
    const doc = new DOMParser().parseFromString(
      "<clipitem id='c1'><start>100</start><end>190</end><in>10</in><out>100</out><duration>90</duration></clipitem>",
      "text/xml",
    );
    const clip = doc.documentElement!;
    const pieces = splitClipitemByTimelineCuts(clip, [120, 140], 1);
    expect(pieces.length).toBe(3);
    expect(pieces[0]!.getElementsByTagName("start")[0]!.textContent).toBe("100");
    expect(pieces[0]!.getElementsByTagName("end")[0]!.textContent).toBe("120");
    expect(pieces[1]!.getElementsByTagName("start")[0]!.textContent).toBe("120");
    expect(pieces[1]!.getElementsByTagName("end")[0]!.textContent).toBe("140");
    expect(pieces[2]!.getElementsByTagName("start")[0]!.textContent).toBe("140");
    expect(pieces[2]!.getElementsByTagName("end")[0]!.textContent).toBe("190");
  });

  it("processes xmeml with mock analyzer", async () => {
    const tmpdirPath = await mkdtemp(join(tmpdir(), "rscut-"));
    const mediaFile = join(tmpdirPath, "source.wav");
    await writeFile(mediaFile, Buffer.from("fake"));
    const inputXml = join(tmpdirPath, "in.xml");
    const outputXml = join(tmpdirPath, "out.xml");
    await writeFile(inputXml, sampleXmeml(mediaFile), "utf8");

    const fakeAnalyzer: KeepRangesAnalyzer = async () => {
      return [
        [new FrameRange(0, 20), new FrameRange(40, 60)],
        [new FrameRange(20, 40), new FrameRange(60, 90)],
      ];
    };

    const result = await processXmemlFile(
      inputXml,
      outputXml,
      1,
      silenceSettings(-40.0, 250, 50, 50),
      false,
      fakeAnalyzer,
      null,
    );

    expect(result.totalRemovedFrames).toBe(50);
    const rawXml = readFileSync(outputXml, "utf8");
    expect((rawXml.match(/<\?xml/gi) ?? []).length).toBe(1);
    const tree = new DOMParser().parseFromString(rawXml, "text/xml");
    const root = tree.documentElement!;
    const audioClips = xpathElements(
      ".//*[local-name()='media']/*[local-name()='audio']/*[local-name()='track'][1]/*[local-name()='clipitem']",
      root,
    );
    expect(audioClips.length).toBe(2);
    expect(audioClips[0]!.getElementsByTagName("start")[0]!.textContent).toBe("0");
    expect(audioClips[0]!.getElementsByTagName("end")[0]!.textContent).toBe("20");
    expect(audioClips[1]!.getElementsByTagName("start")[0]!.textContent).toBe("40");
    expect(audioClips[1]!.getElementsByTagName("end")[0]!.textContent).toBe("60");
  });

  it("splits selected video track using audio cut boundaries", async () => {
    const tmpdirPath = await mkdtemp(join(tmpdir(), "rscut-video-"));
    const mediaFile = join(tmpdirPath, "source.wav");
    await writeFile(mediaFile, Buffer.from("fake"));
    const inputXml = join(tmpdirPath, "in.xml");
    const outputXml = join(tmpdirPath, "out.xml");
    await writeFile(inputXml, sampleXmeml(mediaFile), "utf8");

    const fakeAnalyzer: KeepRangesAnalyzer = async () => {
      return [
        [new FrameRange(0, 20), new FrameRange(40, 60)],
        [new FrameRange(20, 40), new FrameRange(60, 90)],
      ];
    };

    await processXmemlFile(
      inputXml,
      outputXml,
      1,
      silenceSettings(-40.0, 250, 50, 50),
      false,
      fakeAnalyzer,
      null,
      1,
    );

    const rawXml = readFileSync(outputXml, "utf8");
    const tree = new DOMParser().parseFromString(rawXml, "text/xml");
    const root = tree.documentElement!;
    const videoClips = xpathElements(
      ".//*[local-name()='media']/*[local-name()='video']/*[local-name()='track'][1]/*[local-name()='clipitem']",
      root,
    );
    expect(videoClips.length).toBe(4);
    expect(videoClips[0]!.getElementsByTagName("start")[0]!.textContent).toBe("0");
    expect(videoClips[0]!.getElementsByTagName("end")[0]!.textContent).toBe("20");
    expect(videoClips[1]!.getElementsByTagName("start")[0]!.textContent).toBe("20");
    expect(videoClips[1]!.getElementsByTagName("end")[0]!.textContent).toBe("40");
    expect(videoClips[2]!.getElementsByTagName("start")[0]!.textContent).toBe("40");
    expect(videoClips[2]!.getElementsByTagName("end")[0]!.textContent).toBe("60");
    expect(videoClips[3]!.getElementsByTagName("start")[0]!.textContent).toBe("60");
    expect(videoClips[3]!.getElementsByTagName("end")[0]!.textContent).toBe("90");
  });
});
