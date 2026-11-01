import React from 'react';

interface SkeletonBlockProps {
    className?: string;
    width?: string;
    height?: string;
}

export default function SkeletonBlock({
    className = '',
    width = 'w-full',
    height = 'h-4',
}: SkeletonBlockProps) {
    return (
        <div
            className={`bg-[#E5E7EB] rounded ${width} ${height} ${className}`}
            aria-hidden="true"
        />
    );
}
