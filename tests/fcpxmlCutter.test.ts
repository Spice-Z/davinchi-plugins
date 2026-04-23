import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { silenceSettings } from "../src/core/config.js";
import { FrameRange } from "../src/core/models.js";
import {
  formatFcpxTime,
  parseFcpxTime,
  processFcpxmlFile,
} from "../src/core/fcpxmlCutter.js";
import { DOMParser } from "@xmldom/xmldom";
import { xpathElements } from "../src/core/xmlUtils.js";

function sampleFcpxml(mediaPath: string): string {
  const href = pathToFileURL(mediaPath).href;
  return `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.10">
  <resources>
    <asset id="r1" src="${href}" />
  </resources>
  <library>
    <event name="evt">
      <project name="proj">
        <sequence format="rfmt" frameDuration="1/30s" tcStart="0s" tcFormat="NDF">
          <spine>
            <asset-clip name="A1Clip" ref="r1" offset="0s" start="0s" duration="3s" lane="0" audioRole="dialogue"/>
            <asset-clip name="A2Clip" ref="r1" offset="0s" start="0s" duration="3s" lane="-1" audioRole="dialogue"/>
            <asset-clip name="V1Clip" ref="r1" offset="0s" start="0s" duration="3s" lane="1"/>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

describe("fcpxml cutter", () => {
  it("round-trips fcpx time format", () => {
    expect(formatFcpxTime(parseFcpxTime("1/30s"))).toBe("1/30s");
  });

  it("processes fcpxml with mock analyzer", async () => {
    const tmpdirPath = await mkdtemp(join(tmpdir(), "rscut-fcpx-"));
    const mediaFile = join(tmpdirPath, "source.wav");
    await writeFile(mediaFile, Buffer.from("fake"));
    const inputXml = join(tmpdirPath, "in.fcpxml");
    const outputXml = join(tmpdirPath, "out.fcpxml");
    await writeFile(inputXml, sampleFcpxml(mediaFile), "utf8");

    const fakeAnalyzer = async (): Promise<[FrameRange[], FrameRange[]]> => {
      return [[new FrameRange(0, 30), new FrameRange(60, 90)], [new FrameRange(30, 60)]];
    };

    const result = await processFcpxmlFile(
      inputXml,
      outputXml,
      1,
      silenceSettings(-40.0, 200, 50, 50),
      false,
      fakeAnalyzer,
      null,
    );

    expect(result.totalRemovedFrames).toBe(30);
    const xml = readFileSync(outputXml, "utf8");
    expect((xml.match(/<\?xml/gi) ?? []).length).toBe(1);
    const tree = new DOMParser().parseFromString(xml, "text/xml");
    const root = tree.documentElement!;
    const audioClips = xpathElements(".//*[local-name()='asset-clip'][@audioRole]", root);
    expect(audioClips.length).toBe(3);
    expect(audioClips[0]!.getAttribute("offset")).toBe("0/1s");
    expect(audioClips[1]!.getAttribute("offset")).toBe("2/1s");
    expect(audioClips[0]!.getAttribute("duration")).toBe("1/1s");
    expect(audioClips[1]!.getAttribute("duration")).toBe("1/1s");
  });

  it("splits selected video lane using audio cut boundaries", async () => {
    const tmpdirPath = await mkdtemp(join(tmpdir(), "rscut-fcpx-video-"));
    const mediaFile = join(tmpdirPath, "source.wav");
    await writeFile(mediaFile, Buffer.from("fake"));
    const inputXml = join(tmpdirPath, "in.fcpxml");
    const outputXml = join(tmpdirPath, "out.fcpxml");
    await writeFile(inputXml, sampleFcpxml(mediaFile), "utf8");

    const fakeAnalyzer = async (): Promise<[FrameRange[], FrameRange[]]> => {
      return [[new FrameRange(0, 30), new FrameRange(60, 90)], [new FrameRange(30, 60)]];
    };

    await processFcpxmlFile(
      inputXml,
      outputXml,
      1,
      silenceSettings(-40.0, 200, 50, 50),
      false,
      fakeAnalyzer,
      null,
      null,
      1,
    );

    const xml = readFileSync(outputXml, "utf8");
    const tree = new DOMParser().parseFromString(xml, "text/xml");
    const root = tree.documentElement!;
    const videoClips = xpathElements(
      ".//*[local-name()='asset-clip'][not(@audioRole) and @lane='1']",
      root,
    );
    expect(videoClips.length).toBe(3);
    expect(videoClips[0]!.getAttribute("offset")).toBe("0/1s");
    expect(videoClips[1]!.getAttribute("offset")).toBe("1/1s");
    expect(videoClips[2]!.getAttribute("offset")).toBe("2/1s");
    expect(videoClips[0]!.getAttribute("duration")).toBe("1/1s");
    expect(videoClips[1]!.getAttribute("duration")).toBe("1/1s");
    expect(videoClips[2]!.getAttribute("duration")).toBe("1/1s");
  });
});
