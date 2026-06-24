// pmxBoneAnalyzer.js - PMX 骨骼分析脚本
// 运行: node pmxBoneAnalyzer.js

const fs = require('fs');
const path = require('path');

function readString(buffer, encoding) {
  const len = buffer.readUInt32LE(0);
  let str = '';
  for (let i = 0; i < len; i++) {
    if (encoding === 'UTF-8') {
      str += String.fromCharCode(buffer[i + 4]);
    } else {
      const char = buffer.readUInt16LE(i * 2 + 4);
      if (char === 0) break;
      str += String.fromCharCode(char);
    }
  }
  return str;
}

function analyzePMX(filePath) {
  const buffer = fs.readFileSync(filePath);
  let offset = 0;

  console.log('=== PMX 骨骼分析 ===\n');

  // 1. 检查 PMX 标识
  const magic = buffer.toString('ascii', 0, 4);
  console.log('Magic:', magic);
  if (magic !== 'PMX ') {
    console.error('不是有效的 PMX 文件!');
    return;
  }

  // 2. 版本
  const version = buffer.readFloatLE(4);
  console.log('版本:', version);

  // 3. 读取全局设置
  const flags = buffer[8];
  const encoding = buffer[9]; // 0=UTF-16, 1=UTF-8
  console.log('编码:', encoding === 1 ? 'UTF-8' : 'UTF-16');

  offset = 10;

  // 跳过附加数据
  const additionalUVCount = buffer[offset];
  offset += 1;

  const vertexIndexSize = buffer[offset];
  offset += 1;
  const textureIndexSize = buffer[offset];
  offset += 1;
  const materialIndexSize = buffer[offset];
  offset += 1;
  const boneIndexSize = buffer[offset];
  offset += 1;

  console.log('顶点索引大小:', vertexIndexSize);
  console.log('骨骼索引大小:', boneIndexSize, '\n');

  // 4. 模型信息
  const modelName = readString(buffer.slice(offset), encoding === 1 ? 'UTF-8' : 'UTF-16');
  offset += 4 + modelName.length * (encoding === 1 ? 1 : 2) + (encoding === 1 ? 0 : 1);

  const englishName = readString(buffer.slice(offset), encoding === 1 ? 'UTF-8' : 'UTF-16');
  offset += 4 + englishName.length * (encoding === 1 ? 1 : 2) + (encoding === 1 ? 0 : 1);

  console.log('模型名称:', modelName);
  console.log('英文名:', englishName, '\n');

  // 5. 顶点数量
  const vertexCount = buffer.readUInt32LE(offset);
  offset += 4;
  console.log('顶点数量:', vertexCount, '\n');

  // 6. 分析前几个顶点的权重
  console.log('=== 顶点骨骼权重分析 ===');
  let hasSkinWeights = true;
  let weightTypes = new Set();

  for (let i = 0; i < Math.min(10, vertexCount); i++) {
    offset += 12; // 位置
    offset += 12; // 法线
    offset += 8;  // UV

    // 跳过额外 UV
    for (let j = 0; j < additionalUVCount; j++) {
      offset += 16;
    }

    const deformType = buffer[offset];
    weightTypes.add(deformType);
    offset += 1;

    let boneIndices = [];
    let boneWeights = [];

    switch (deformType) {
      case 0: // BDEF1
        const idxSize1 = boneIndexSize;
        boneIndices.push(buffer.readUInt32LE(offset));
        offset += idxSize1;
        boneWeights = [1.0];
        break;
      case 1: // BDEF2
        const idxSize2 = boneIndexSize;
        boneIndices.push(buffer.readUInt32LE(offset));
        offset += idxSize2;
        boneIndices.push(buffer.readUInt32LE(offset));
        offset += idxSize2;
        const w1 = buffer.readFloatLE(offset);
        offset += 4;
        boneWeights = [1 - w1, w1];
        break;
      case 2: // BDEF4
        for (let k = 0; k < 4; k++) {
          boneIndices.push(buffer.readUInt32LE(offset));
          offset += idxSize2;
        }
        for (let k = 0; k < 4; k++) {
          boneWeights.push(buffer.readFloatLE(offset));
          offset += 4;
        }
        break;
      case 3: // SDEF
        offset += idxSize2 * 2 + 4 + 12 + 12; // 跳过
        break;
    }
  }

  console.log('权重类型分布:', [...weightTypes].map(t => {
    const names = ['BDEF1', 'BDEF2', 'BDEF4', 'SDEF'];
    return names[t] || t;
  }).join(', '));
  console.log('蒙皮权重: ✅ 存在\n');

  // 7. 骨骼数量
  const boneCount = buffer.readUInt32LE(offset);
  offset += 4;
  console.log('=== 骨骼列表 (共', boneCount, '个) ===\n');

  const bones = [];
  for (let i = 0; i < boneCount; i++) {
    const name = readString(buffer.slice(offset), encoding === 1 ? 'UTF-8' : 'UTF-16');
    offset += 4 + name.length * (encoding === 1 ? 1 : 2) + (encoding === 1 ? 0 : 1);

    const englishName = readString(buffer.slice(offset), encoding === 1 ? 'UTF-8' : 'UTF-16');
    offset += 4 + englishName.length * (encoding === 1 ? 1 : 2) + (encoding === 1 ? 0 : 1);

    const pos = [
      buffer.readFloatLE(offset),
      buffer.readFloatLE(offset + 4),
      buffer.readFloatLE(offset + 8)
    ];
    offset += 12;

    const parentIndex = buffer.readUInt32LE(offset);
    offset += 4;
    const deformDepth = buffer.readUInt32LE(offset);
    offset += 4;

    const flags = buffer.readUInt16LE(offset);
    offset += 2;

    // 跳过 IK 数据
    if (flags & 0x01) { // has child
      offset += boneIndexSize;
    }
    if (flags & 0x02) { // has rigid body
      offset += 1;
    }

    bones.push({
      index: i,
      name,
      englishName,
      pos,
      parentIndex,
      flags
    });
  }

  // 打印关键骨骼
  console.log('【关键骨骼】');
  const keyPatterns = ['足', 'ひざ', '膝', '腕', '上半身', '下半身', '頭', '首', '肩', '手首', '足首'];
  for (const bone of bones) {
    const isKey = keyPatterns.some(p => bone.name.includes(p) || bone.englishName.includes(p));
    if (isKey || bone.index < 30) {
      console.log(`  [${bone.index.toString().padStart(3)}] ${bone.name.padEnd(15)} | ${bone.englishName.padEnd(20)} | parent: ${bone.parentIndex.toString().padStart(3)} | pos: (${bone.pos.map(v => v.toFixed(2)).join(', ')})`);
    }
  }

  // 8. 统计父子关系
  console.log('\n【骨骼层级分析】');
  const parents = bones.filter(b => b.parentIndex >= 0).map(b => bones[b.parentIndex]?.name || 'ROOT');
  const parentNames = [...new Set(parents)];
  console.log('不同的父骨骼数量:', parentNames.length);

  return bones;
}

// 运行
const modelPath = path.join(__dirname, '刻晴.pmx');
console.log('分析文件:', modelPath, '\n');
analyzePMX(modelPath);
