// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { IMAGE_TOPIC_SCHEMAS, getImageTopics } from "./videoExporter";

describe("IMAGE_TOPIC_SCHEMAS", () => {
  it("includes ROS and Foxglove image schema names", () => {
    expect(IMAGE_TOPIC_SCHEMAS).toContain("sensor_msgs/Image");
    expect(IMAGE_TOPIC_SCHEMAS).toContain("sensor_msgs/msg/Image");
    expect(IMAGE_TOPIC_SCHEMAS).toContain("sensor_msgs/CompressedImage");
    expect(IMAGE_TOPIC_SCHEMAS).toContain("sensor_msgs/msg/CompressedImage");
    expect(IMAGE_TOPIC_SCHEMAS).toContain("foxglove.RawImage");
    expect(IMAGE_TOPIC_SCHEMAS).toContain("foxglove.CompressedImage");
  });
});

describe("getImageTopics", () => {
  it("returns only topics with image schemas", () => {
    const topics = [
      { name: "/camera/image", schemaName: "sensor_msgs/Image" },
      { name: "/camera/compressed", schemaName: "sensor_msgs/CompressedImage" },
      { name: "/imu/data", schemaName: "sensor_msgs/Imu" },
      { name: "/odom", schemaName: "nav_msgs/Odometry" },
      { name: "/foxglove_cam", schemaName: "foxglove.CompressedImage" },
    ];

    const result = getImageTopics(topics);

    expect(result).toHaveLength(3);
    expect(result.map((t) => t.name)).toEqual([
      "/camera/image",
      "/camera/compressed",
      "/foxglove_cam",
    ]);
  });

  it("returns empty array when no image topics exist", () => {
    const topics = [
      { name: "/imu/data", schemaName: "sensor_msgs/Imu" },
    ];

    expect(getImageTopics(topics)).toHaveLength(0);
  });

  it("handles topics with undefined schemaName", () => {
    const topics = [
      { name: "/unknown", schemaName: undefined },
      { name: "/camera", schemaName: "sensor_msgs/Image" },
    ];

    const result = getImageTopics(topics);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("/camera");
  });
});
